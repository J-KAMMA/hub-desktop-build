//! Operator-approved local command execution and outbound HTTP for the
//! pi_work sidecar tool surface (`hub_exec`, `hub_http`).
//!
//! These tools widen the harness beyond the workspace: a call is arbitrary
//! code execution or network egress, so the caller — the pi_sidecar
//! executor — parks every one on an operator decision before it reaches this
//! module. Nothing here is itself an approval: `ExecRequest`/`HttpRequest`
//! parse and bound a proposal, `run`/`fetch` only ever see a decided one.
//! Args are an argv array passed to `Command` directly; no shell parses them.

use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const MAX_PROGRAM_CHARS: usize = 260;
const MAX_ARGS: usize = 64;
const MAX_ARG_CHARS: usize = 8 * 1024;
const MAX_STDIN_BYTES: usize = 64 * 1024;
/// Per-stream capture ceiling; a runaway writer gets truncated, not OOMed.
const MAX_OUTPUT_BYTES: u64 = 64 * 1024;
/// After the child exits (or is killed) a spawned grandchild can still hold
/// the pipes open; bound the drain so the call returns what was captured.
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(5);
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 120_000;
const MAX_EXEC_TIMEOUT_MS: u64 = 600_000;

const MAX_METHOD_CHARS: usize = 16;
const MAX_URL_CHARS: usize = 4096;
const MAX_HEADERS: usize = 32;
const MAX_HEADER_NAME_CHARS: usize = 64;
const MAX_HEADER_VALUE_CHARS: usize = 8 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS: u64 = 30_000;
const MAX_HTTP_TIMEOUT_MS: u64 = 120_000;

/// Environment a `hub_exec` child inherits. Credentials that live in env
/// vars never ride along — the child is arbitrary code, and the approval
/// dialog shows its argv, not its environment. Interactive CLIs keep what
/// they need on disk (config dirs under APPDATA/USERPROFILE), which the
/// operator approves when they approve the command line.
const ENV_PASSTHROUGH: &[&str] = &[
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "OS",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "PUBLIC",
    "ALLUSERSPROFILE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PSMODULEPATH",
    "HOME",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

fn curated_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(key, _)| {
            ENV_PASSTHROUGH
                .iter()
                .any(|allowed| key.eq_ignore_ascii_case(allowed))
        })
        .collect()
}

fn bounded_str(map: &Map<String, Value>, key: &str, max: usize) -> Result<String, String> {
    let value = map
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key}_required"))?;
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("{key}_invalid"));
    }
    Ok(value.to_owned())
}

fn timeout_ms(map: &Map<String, Value>, default: u64, max: u64) -> Result<Duration, String> {
    match map.get("timeoutMs") {
        None | Some(Value::Null) => Ok(Duration::from_millis(default)),
        Some(Value::Number(n)) => {
            let ms = n.as_u64().ok_or("timeout_invalid")?;
            if ms == 0 || ms > max {
                return Err("timeout_invalid".into());
            }
            Ok(Duration::from_millis(ms))
        }
        _ => Err("timeout_invalid".into()),
    }
}

/// A parsed `hub_exec` call: one program plus an argv array. `program` is a
/// name or path resolved by the OS; arguments never join a shell string.
#[derive(Debug)]
pub struct ExecRequest {
    pub program: String,
    pub args: Vec<String>,
    /// Workspace-relative directory; "" means the workspace root.
    pub cwd: String,
    pub timeout: Duration,
    pub stdin: Option<String>,
}

impl ExecRequest {
    /// The parsed request as shown on an approval (and matched against a
    /// declared verification command): every field, nothing summarized.
    pub fn approval_detail(&self) -> Value {
        serde_json::json!({"kind":"exec","program":self.program,"args":self.args,
            "cwd":self.cwd,"stdin":self.stdin,"timeoutMs":self.timeout.as_millis()})
    }

    pub fn parse(value: Value) -> Result<Self, String> {
        let map = value.as_object().ok_or("invalid_exec")?;
        let program = bounded_str(map, "program", MAX_PROGRAM_CHARS)?;
        let args = match map.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => {
                if items.len() > MAX_ARGS {
                    return Err("exec_args_too_many".into());
                }
                items
                    .iter()
                    .map(|item| {
                        item.as_str()
                            .filter(|arg| arg.chars().count() <= MAX_ARG_CHARS)
                            .map(str::to_owned)
                            .ok_or_else(|| "exec_arg_invalid".to_owned())
                    })
                    .collect::<Result<Vec<_>, _>>()?
            }
            _ => return Err("exec_args_invalid".into()),
        };
        let cwd = match map.get("cwd") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(dir)) => {
                crate::agent_tools::relative(dir)?;
                dir.clone()
            }
            _ => return Err("cwd_invalid".into()),
        };
        let stdin = match map.get("stdin") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                if text.len() > MAX_STDIN_BYTES {
                    return Err("stdin_too_large".into());
                }
                Some(text.clone())
            }
            _ => return Err("stdin_invalid".into()),
        };
        Ok(Self {
            program,
            args,
            cwd,
            timeout: timeout_ms(map, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS)?,
            stdin,
        })
    }

    /// Every parsed execution input, JSON-encoded to preserve argv boundaries,
    /// literal controls, empty strings and optional stdin without hidden tails.
    pub fn describe(&self) -> String {
        format!(
            "exec {}",
            json!({
                "program": self.program,
                "args": self.args,
                "cwd": self.cwd,
                "stdin": self.stdin,
                "timeoutMs": self.timeout.as_millis(),
            })
        )
    }

    /// Runs the approved command inside the workspace. Both output pipes are
    /// drained concurrently and to EOF: a child blocked on a full pipe never
    /// exits, so capping by refusing to read would turn every verbose command
    /// into a timeout. Storage stays capped; the rest is discarded.
    pub async fn run(&self, workspace: &Path) -> Result<Value, String> {
        self.run_with_cancel(workspace, std::future::pending())
            .await
    }

    pub async fn run_with_cancel(
        &self,
        workspace: &Path,
        cancel: impl std::future::Future<Output = ()>,
    ) -> Result<Value, String> {
        tokio::pin!(cancel);
        let cwd = {
            let workspace = workspace.to_owned();
            let directory = self.cwd.clone();
            // `checked` walks every path component on disk; keep the syscalls
            // off the async worker.
            tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
                let cwd = crate::agent_tools::checked(&workspace, Path::new(&directory), false)?;
                if !cwd.is_dir() {
                    return Err("cwd_not_directory".into());
                }
                Ok(cwd)
            })
            .await
            .map_err(|_| "exec_internal".to_owned())??
        };
        tokio::select! {
            biased;
            _ = &mut cancel => return Ok(json!({"exitCode":null,"timedOut":false,"cancelled":true,"stdout":"","stderr":"","stdoutTruncated":false,"stderrTruncated":false})),
            _ = std::future::ready(()) => {},
        }
        let mut command = crate::local_cli::quiet_command(&self.program);
        command
            .args(&self.args)
            .current_dir(&cwd)
            .env_clear()
            .envs(curated_env())
            .stdin(if self.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| "exec_spawn_failed".to_owned())?;
        let mut stdin = child.stdin.take();
        let mut stdout = child.stdout.take().ok_or("exec_stdio_unavailable")?;
        let mut stderr = child.stderr.take().ok_or("exec_stdio_unavailable")?;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let timeout = self.timeout;
        let waited = async {
            let reason = tokio::select! {
                exit = child.wait() => return (exit.ok().and_then(|status| status.code()), false, false),
                _ = tokio::time::sleep(timeout) => "timeout",
                _ = &mut cancel => "cancelled",
            };
            #[cfg(windows)]
            if let Some(pid) = child.id() {
                let _ = crate::local_cli::quiet_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await;
            }
            let _ = child.kill().await;
            (None, reason == "timeout", reason == "cancelled")
        };
        let input = async {
            // Dropping the pipe closes stdin so the child sees EOF; a
            // write that outlives the deadline is cut with the pipe.
            if let Some(mut pipe) = stdin.take() {
                if let Some(text) = &self.stdin {
                    let _ = pipe.write_all(text.as_bytes()).await;
                }
            }
        };
        let drained = async {
            tokio::join!(
                capped_drain(&mut stdout, &mut out),
                capped_drain(&mut stderr, &mut err),
            )
        };
        let ((status, timed_out, cancelled), _, truncated) = tokio::join!(
            waited,
            tokio::time::timeout(timeout, input),
            tokio::time::timeout(timeout + OUTPUT_DRAIN_GRACE, drained),
        );
        let (stdout_truncated, stderr_truncated) = truncated.unwrap_or((true, true));
        Ok(json!({
            "exitCode": status,
            "timedOut": timed_out,
            "cancelled": cancelled,
            "stdout": String::from_utf8_lossy(&out),
            "stderr": String::from_utf8_lossy(&err),
            "stdoutTruncated": stdout_truncated,
            "stderrTruncated": stderr_truncated,
        }))
    }
}

/// Reads a child pipe to EOF while keeping at most `MAX_OUTPUT_BYTES` —
/// storage is capped, but draining continues so a verbose writer can still
/// exit instead of blocking on a full buffer until the timeout kills it.
async fn capped_drain<R: AsyncRead + Unpin>(reader: &mut R, out: &mut Vec<u8>) -> bool {
    let mut truncated = false;
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = (MAX_OUTPUT_BYTES as usize).saturating_sub(out.len());
                if n > room {
                    truncated = true;
                }
                out.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
    }
    truncated
}

/// One client per process: building it installs the TLS backend and root
/// store, and a per-call pool could never reuse a connection anyway. The
/// no-redirect policy lives on the client; the timeout applies per request.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "http_client_unavailable".to_owned())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A parsed `hub_http` call. Only http/https URLs without userinfo — a
/// credential-bearing URL is exactly the shape an exfiltration attempt takes.
#[derive(Debug)]
pub struct HttpRequest {
    pub method: reqwest::Method,
    pub url: reqwest::Url,
    pub headers: Vec<(reqwest::header::HeaderName, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
}

impl HttpRequest {
    pub fn parse(value: Value) -> Result<Self, String> {
        let map = value.as_object().ok_or("invalid_http")?;
        let method_raw = bounded_str(map, "method", MAX_METHOD_CHARS)?;
        let method = method_raw
            .parse::<reqwest::Method>()
            .map_err(|_| "method_invalid".to_owned())?;
        let url_raw = bounded_str(map, "url", MAX_URL_CHARS)?;
        let url = reqwest::Url::parse(&url_raw).map_err(|_| "url_invalid".to_owned())?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.host_str().is_none()
        {
            return Err("url_not_allowed".into());
        }
        let headers = match map.get("headers") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Object(entries)) => {
                if entries.len() > MAX_HEADERS {
                    return Err("headers_too_many".into());
                }
                entries
                    .iter()
                    .map(|(name, value)| {
                        let value = value.as_str().ok_or_else(|| "header_invalid".to_owned())?;
                        if name.chars().count() > MAX_HEADER_NAME_CHARS
                            || value.chars().count() > MAX_HEADER_VALUE_CHARS
                        {
                            return Err("header_invalid".to_owned());
                        }
                        let name = name
                            .parse::<reqwest::header::HeaderName>()
                            .map_err(|_| "header_invalid".to_owned())?;
                        reqwest::header::HeaderValue::from_str(value)
                            .map_err(|_| "header_invalid".to_owned())?;
                        Ok((name, value.to_owned()))
                    })
                    .collect::<Result<Vec<_>, _>>()?
            }
            _ => return Err("headers_invalid".into()),
        };
        let body = match map.get("body") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                if text.len() > MAX_REQUEST_BODY_BYTES {
                    return Err("body_too_large".into());
                }
                Some(text.clone())
            }
            _ => return Err("body_invalid".into()),
        };
        Ok(Self {
            method,
            url,
            headers,
            body,
            timeout: timeout_ms(map, DEFAULT_HTTP_TIMEOUT_MS, MAX_HTTP_TIMEOUT_MS)?,
        })
    }

    /// Every parsed request input, JSON-encoded without truncating headers or
    /// body, and preserving the distinction between an absent and empty body.
    pub fn describe(&self) -> String {
        format!(
            "{} {}\n{}",
            self.method,
            self.url,
            json!({
                "method": self.method.as_str(),
                "url": self.url.as_str(),
                "headers": self.headers.iter().map(|(name, value)| (name.as_str(), value)).collect::<Vec<_>>(),
                "body": self.body,
                "timeoutMs": self.timeout.as_millis(),
            })
        )
    }

    /// Sends the approved request. Redirects are not followed — the operator
    /// approved this URL, not wherever it might bounce to.
    pub async fn fetch(&self) -> Result<Value, String> {
        let mut request = client()?
            .request(self.method.clone(), self.url.clone())
            .timeout(self.timeout);
        for (name, value) in &self.headers {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(value) {
                request = request.header(name.clone(), value);
            }
        }
        if let Some(body) = &self.body {
            request = request.body(body.clone());
        }
        let mut response = request.send().await.map_err(|error| {
            format!(
                "http_failed: {}",
                error
                    .status()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "transport".into())
            )
        })?;
        let status = response.status().as_u16();
        let headers: Map<String, Value> = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    Value::String(value.to_str().unwrap_or("").to_owned()),
                )
            })
            .collect();
        let mut body = Vec::new();
        let mut truncated = false;
        while let Ok(Some(chunk)) = response.chunk().await {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                body.extend_from_slice(&chunk[..MAX_RESPONSE_BYTES - body.len()]);
                truncated = true;
                break;
            }
            body.extend_from_slice(&chunk);
        }
        Ok(json!({
            "status": status,
            "headers": Value::Object(headers),
            "body": String::from_utf8_lossy(&body),
            "truncated": truncated,
        }))
    }
}

const MAX_PAY_NOTE_CHARS: usize = 200;

/// A parsed `hub_pay` call: a purchase proposal only. The desktop never moves
/// funds — approval resolves to the paired Hub panel, which executes the order
/// against the operator's account grant and returns the outcome through the
/// decision channel. This type validates the spec a human is asked to approve.
#[derive(Debug)]
pub struct PayRequest {
    pub product_id: String,
    pub quantity: u32,
    pub note: Option<String>,
}

impl PayRequest {
    pub fn parse(value: Value) -> Result<Self, String> {
        let map = value.as_object().ok_or("invalid_pay")?;
        let product_id = bounded_str(map, "productId", 64)?;
        if !uuid::Uuid::parse_str(&product_id).is_ok() {
            return Err("product_id_invalid".into());
        }
        let quantity = match map.get("quantity") {
            None | Some(Value::Null) => 1,
            Some(Value::Number(n))
                if n.is_u64() && n.as_u64().unwrap() >= 1 && n.as_u64().unwrap() <= 20 =>
            {
                n.as_u64().unwrap() as u32
            }
            _ => return Err("quantity_invalid".into()),
        };
        let note = match map.get("note") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if text.chars().count() <= MAX_PAY_NOTE_CHARS => {
                Some(text.clone())
            }
            _ => return Err("note_invalid".into()),
        };
        Ok(Self {
            product_id,
            quantity,
            note,
        })
    }

    /// The structured proposal the panel needs to execute the purchase on
    /// approval — id and quantity only; the note is display text.
    pub fn detail(&self) -> Value {
        json!({ "productId": self.product_id, "quantity": self.quantity })
    }

    /// The one-line description a human approves or denies.
    pub fn describe(&self) -> String {
        let base = format!("purchase product {} ×{}", self.product_id, self.quantity);
        match &self.note {
            Some(note) if !note.is_empty() => format!("{base} — {note}"),
            _ => base,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn exec_rejects_empty_program_and_bad_args() {
        assert!(ExecRequest::parse(json!({})).is_err());
        assert!(ExecRequest::parse(json!({"program": ""})).is_err());
        assert!(ExecRequest::parse(json!({"program": "x", "args": "not-array"})).is_err());
        assert!(ExecRequest::parse(json!({"program": "x", "args": [1]})).is_err());
    }

    #[test]
    fn exec_confines_cwd_to_workspace_rules() {
        assert!(ExecRequest::parse(json!({"program": "x", "cwd": "../up"})).is_err());
        assert!(ExecRequest::parse(json!({"program": "x", "cwd": "C:/abs"})).is_err());
        assert!(ExecRequest::parse(json!({"program": "x", "cwd": "sub/dir"})).is_ok());
    }

    #[test]
    fn exec_describe_shows_full_argv() {
        let request = ExecRequest::parse(json!({
            "program": "cargo", "args": ["test", "--workspace"], "cwd": "src"
        }))
        .unwrap();
        assert_eq!(
            request.describe(),
            format!(
                "exec {}",
                json!({
                    "program": "cargo", "args": ["test", "--workspace"], "cwd": "src",
                    "stdin": null, "timeoutMs": DEFAULT_EXEC_TIMEOUT_MS
                })
            )
        );
    }

    #[tokio::test]
    async fn exec_runs_a_command_and_caps_environment() {
        let dir = std::env::temp_dir().join(format!("hub-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        // A sentinel secret must not reach the child's environment.
        std::env::set_var("HUB_EXEC_SENTINEL_TEST", "secret-value");
        let request = ExecRequest::parse(json!({
            "program": "cmd", "args": ["/c", "echo %HUB_EXEC_SENTINEL_TEST% & echo out"]
        }))
        .unwrap();
        let result = request.run(&dir).await.unwrap();
        std::env::remove_var("HUB_EXEC_SENTINEL_TEST");
        let stdout = result["stdout"].as_str().unwrap();
        assert!(
            stdout.contains("%HUB_EXEC_SENTINEL_TEST%"),
            "stdout: {stdout}"
        );
        assert!(stdout.contains("out"));
        assert_eq!(result["exitCode"], 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn exec_times_out_and_kills() {
        let dir = std::env::temp_dir().join(format!("hub-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let request = ExecRequest::parse(json!({
            "program": "cmd", "args": ["/c", "ping -n 30 127.0.0.1 >nul"],
            "timeoutMs": 300
        }))
        .unwrap();
        let result = request.run(&dir).await.unwrap();
        assert_eq!(result["timedOut"], true);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn exec_drains_flooded_pipes_without_timing_out() {
        let dir = std::env::temp_dir().join(format!("hub-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        // ~240KB on stderr while stdout stays open: refusing to drain past
        // the cap blocks the child on a full pipe and it never exits.
        let flood = format!(
            "echo out&for /l %i in (1,1,3000) do @echo {} 1>&2",
            "flood".repeat(16)
        );
        let request = ExecRequest::parse(json!({
            "program": "cmd", "args": ["/c", flood], "timeoutMs": 20000
        }))
        .unwrap();
        let result = request.run(&dir).await.unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(result["timedOut"], false);
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["stderrTruncated"], true);
        assert_eq!(result["stdoutTruncated"], false);
        assert!(result["stdout"].as_str().unwrap().contains("out"));
        assert!(result["stderr"].as_str().unwrap().len() <= MAX_OUTPUT_BYTES as usize);
    }

    #[tokio::test]
    async fn exec_writes_stdin_then_closes_it() {
        let dir = std::env::temp_dir().join(format!("hub-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let request = ExecRequest::parse(json!({
            "program": "findstr", "args": ["hub-stdin-mark"], "stdin": "hub-stdin-mark\n",
            "timeoutMs": 10000
        }))
        .unwrap();
        let result = request.run(&dir).await.unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(result["timedOut"], false);
        assert!(result["stdout"]
            .as_str()
            .unwrap()
            .contains("hub-stdin-mark"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cancellation_stops_child_processes_and_a_pre_cancelled_command_never_starts() {
        let dir = std::env::temp_dir().join(format!("hub-exec-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let request = ExecRequest::parse(json!({"program":"node","args":["-e","require('fs').writeFileSync('forbidden.txt','x')"]})).unwrap();
        assert_eq!(
            request
                .run_with_cancel(&dir, std::future::ready(()))
                .await
                .unwrap()["cancelled"],
            true
        );
        assert!(!dir.join("forbidden.txt").exists());
        let child = "require('fs').writeFileSync('child-ready.txt','yes');setTimeout(()=>require('fs').writeFileSync('late.txt','bad'),1200)";
        let script = format!("require('child_process').spawn(process.execPath,['-e',{}],{{stdio:'inherit',windowsHide:true}});setInterval(()=>{{}},100)",serde_json::to_string(child).unwrap());
        let request =
            ExecRequest::parse(json!({"program":"node","args":["-e",script],"timeoutMs":10000}))
                .unwrap();
        let wait_dir = dir.clone();
        let result = request
            .run_with_cancel(&dir, async move {
                tokio::time::timeout(Duration::from_secs(30), async {
                    while !wait_dir.join("child-ready.txt").exists() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
            })
            .await
            .unwrap();
        assert_eq!(result["cancelled"], true);
        assert!(result["exitCode"].is_null());
        tokio::time::sleep(Duration::from_millis(1400)).await;
        assert!(!dir.join("late.txt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn describe_preserves_every_exec_input_at_parse_limits() {
        let arg = format!("{}TAIL", "🧪".repeat(MAX_ARG_CHARS - 4));
        let stdin = format!("{}END!", "🧪".repeat((MAX_STDIN_BYTES - 4) / 4));
        let input = json!({
            "program": "x".repeat(MAX_PROGRAM_CHARS),
            "args": vec![arg; MAX_ARGS], "cwd": "s".repeat(240),
            "stdin": stdin, "timeoutMs": MAX_EXEC_TIMEOUT_MS
        });
        let request = ExecRequest::parse(input.clone()).unwrap();
        let text = request.describe();
        let decoded: Value = serde_json::from_str(text.strip_prefix("exec ").unwrap()).unwrap();
        assert_eq!(decoded, input);
        assert!(text.contains("TAIL"));
        assert!(text.contains("END!"));
    }

    #[test]
    fn describe_preserves_exec_boundaries_controls_and_optional_stdin() {
        let request = ExecRequest::parse(json!({
            "program": "x", "args": ["", "a b", "a", "b", "\"\\\n\r\t\u{0}🧪"],
            "stdin": "\n\u{0}末尾", "timeoutMs": 1
        }))
        .unwrap();
        let text = request.describe();
        let decoded: Value = serde_json::from_str(text.strip_prefix("exec ").unwrap()).unwrap();
        assert_eq!(
            decoded,
            json!({
                "program": "x", "args": request.args, "cwd": "", "stdin": request.stdin,
                "timeoutMs": 1
            })
        );
        assert!(!text.contains(['\n', '\r', '\t', '\0']));
        let single = ExecRequest::parse(json!({"program":"x", "args":["a b"]})).unwrap();
        let separate = ExecRequest::parse(json!({"program":"x", "args":["a", "b"]})).unwrap();
        assert_ne!(single.describe(), separate.describe());
        let absent = ExecRequest::parse(json!({"program":"x"})).unwrap();
        let empty = ExecRequest::parse(json!({"program":"x", "stdin":""})).unwrap();
        assert_ne!(absent.describe(), empty.describe());
        assert_eq!(
            absent.describe(),
            ExecRequest::parse(json!({"program":"x", "args":null, "stdin":null, "timeoutMs":null}))
                .unwrap()
                .describe()
        );
        assert_ne!(
            absent.describe(),
            ExecRequest::parse(json!({"program":"x", "timeoutMs":1}))
                .unwrap()
                .describe()
        );
    }

    #[test]
    fn http_rejects_bad_methods_urls_and_userinfo() {
        assert!(HttpRequest::parse(json!({"method": "G ET", "url": "https://x/"})).is_err());
        assert!(HttpRequest::parse(json!({"method": "GET", "url": "file:///etc/passwd"})).is_err());
        assert!(HttpRequest::parse(json!({"method": "GET", "url": "https://u:p@x/"})).is_err());
        assert!(HttpRequest::parse(
            json!({"method": "GET", "url": "https://x/", "headers": {"bad name": "v"}})
        )
        .is_err());
        assert!(HttpRequest::parse(
            json!({"method": "GET", "url": "https://x/", "headers": {"ok": "line\nbreak"}})
        )
        .is_err());
    }

    #[tokio::test]
    async fn http_fetches_a_real_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = socket.read(&mut buf);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nx-test: yes\r\n\r\nhello")
                .unwrap();
        });
        let request = HttpRequest::parse(json!({
            "method": "GET", "url": format!("http://127.0.0.1:{port}/path")
        }))
        .unwrap();
        let result = request.fetch().await.unwrap();
        assert_eq!(result["status"], 200);
        assert_eq!(result["body"], "hello");
        assert_eq!(result["headers"]["x-test"], "yes");
    }

    #[test]
    fn pay_parses_and_bounds_the_proposal() {
        let id = uuid::Uuid::new_v4().to_string();
        let request = PayRequest::parse(json!({"productId": id})).unwrap();
        assert_eq!(request.quantity, 1);
        assert_eq!(request.detail()["productId"], json!(id));
        assert!(PayRequest::parse(json!({"productId": "not-a-uuid"})).is_err());
        assert!(PayRequest::parse(json!({"productId": id, "quantity": 0})).is_err());
        assert!(PayRequest::parse(json!({"productId": id, "quantity": 21})).is_err());
        assert!(PayRequest::parse(json!({"productId": id, "quantity": 1.5})).is_err());
        assert!(PayRequest::parse(json!({"productId": id, "note": "x".repeat(201)})).is_err());
        let request =
            PayRequest::parse(json!({"productId": id, "quantity": 2, "note": "gift"})).unwrap();
        assert!(request.describe().contains("×2"));
    }

    #[test]
    fn http_describe_shows_method_url_headers_and_body() {
        let request = HttpRequest::parse(json!({
            "method": "POST", "url": "https://api.example.com/x",
            "headers": {"authorization": "Bearer abc"}, "body": "{\"a\":1}"
        }))
        .unwrap();
        let text = request.describe();
        assert!(text.contains("POST https://api.example.com/x"));
        let decoded: Value = serde_json::from_str(text.split_once('\n').unwrap().1).unwrap();
        assert_eq!(
            decoded,
            json!({
                "method":"POST", "url":"https://api.example.com/x",
                "headers":[["authorization", "Bearer abc"]], "body":"{\"a\":1}",
                "timeoutMs":DEFAULT_HTTP_TIMEOUT_MS
            })
        );
    }

    #[test]
    fn describe_preserves_http_inputs_at_parse_limits() {
        let headers: Map<String, Value> = (0..MAX_HEADERS)
            .map(|i| {
                (
                    format!("x-{i:02}{}", "h".repeat(MAX_HEADER_NAME_CHARS - 4)),
                    json!("v".repeat(MAX_HEADER_VALUE_CHARS)),
                )
            })
            .collect();
        let body = format!("{}TAIL", "🧪".repeat((MAX_REQUEST_BODY_BYTES - 4) / 4));
        let url = format!(
            "https://example.com/{}",
            "a".repeat(MAX_URL_CHARS - "https://example.com/".len())
        );
        let request = HttpRequest::parse(json!({
            "method":"M".repeat(MAX_METHOD_CHARS), "url":url, "headers":headers,
            "body":body, "timeoutMs":MAX_HTTP_TIMEOUT_MS
        }))
        .unwrap();
        let text = request.describe();
        let decoded: Value = serde_json::from_str(text.split_once('\n').unwrap().1).unwrap();
        assert_eq!(decoded["body"], json!(body));
        assert_eq!(decoded["url"], json!(url));
        assert_eq!(decoded["method"], json!("M".repeat(MAX_METHOD_CHARS)));
        assert_eq!(decoded["timeoutMs"], json!(MAX_HTTP_TIMEOUT_MS));
        assert_eq!(
            decoded["headers"],
            json!(request
                .headers
                .iter()
                .map(|(n, v)| (n.as_str(), v))
                .collect::<Vec<_>>())
        );
        assert_eq!(decoded["headers"].as_array().unwrap().len(), MAX_HEADERS);
        assert!(text.contains("TAIL"));
    }

    #[test]
    fn describe_preserves_http_controls_empty_and_absent_body() {
        let request = HttpRequest::parse(json!({
            "method":"POST", "url":"https://example.com/🧪",
            "headers":{"x-control":"\"\\\t"}, "body":"\"\\\n\r\t\u{0}🧪", "timeoutMs":1
        }))
        .unwrap();
        let text = request.describe();
        let encoded = text.split_once('\n').unwrap().1;
        assert!(!encoded.contains(['\n', '\r', '\t', '\0']));
        let decoded: Value = serde_json::from_str(encoded).unwrap();
        assert_eq!(decoded["body"], json!(request.body));
        assert_eq!(decoded["headers"], json!([["x-control", "\"\\\t"]]));
        assert_eq!(decoded["url"], json!(request.url.as_str()));
        let absent =
            HttpRequest::parse(json!({"method":"GET", "url":"https://example.com/"})).unwrap();
        let empty =
            HttpRequest::parse(json!({"method":"GET", "url":"https://example.com/", "body":""}))
                .unwrap();
        assert_ne!(absent.describe(), empty.describe());
        assert_eq!(absent.describe(), HttpRequest::parse(json!({"method":"GET", "url":"https://example.com/", "body":null, "headers":null, "timeoutMs":null})).unwrap().describe());
        assert_ne!(
            absent.describe(),
            HttpRequest::parse(
                json!({"method":"GET", "url":"https://example.com/", "timeoutMs":1})
            )
            .unwrap()
            .describe()
        );
    }
}
