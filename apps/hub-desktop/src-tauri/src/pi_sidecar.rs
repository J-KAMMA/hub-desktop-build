//! Pi SDK sidecar transport (P2 delegation).
//!
//! The Pi coding-agent SDK (`@earendil-works/pi-coding-agent`) runs as a child
//! process whose `customTools[].execute` delegates every tool invocation back
//! to Hub over stdio JSONL. This module is Hub's side of that wire.
//!
//! Wire protocol v1 (verified against the PoC in %TEMP%\pi-poc):
//!
//!   sidecar -> Hub:  {"type":"hello","proto":1,"activeTools":[...],"tools":[...]}
//!                    {"type":"tool_call","id":"tc_1","name":"hub_read","args":{...}}
//!                    {"type":"cancel","id":"tc_1"}
//!                    {"type":"event","event":{...AgentEvent...}}
//!                    {"type":"partial","text":"…assistant text delta…"}
//!                    {"type":"agent_done","ok":true}
//!   Hub -> sidecar:  {"type":"tool_partial","id":"tc_1","content":[...],"details":{...}}
//!                    {"type":"tool_result","id":"tc_1","content":[...],"details":{...},"usage":...,"terminate":...}
//!                    {"type":"tool_error","id":"tc_1","message":"..."}
//!
//! Semantics mirrored from the PoC:
//! - `tool_error` rejects the pending execute() (permission denials AND
//!   executor failures travel the same channel; pi turns it into an isError
//!   tool result). `cancel` fires when pi's AbortSignal trips; an extra
//!   tool_error ack is safe because the sidecar drops late replies.
//! - `hello` advertises the live tool surface; Hub stays authoritative on
//!   what it will execute.
//! - `agent_done` ends the conversation; EOF after it is the clean exit.
//!
//! Boundaries:
//! - No filesystem or shell work lives here. `tool_call` frames go to an
//!   injected `ToolExecutor`. Wiring that executor to `agent_tools`
//!   (Kind::{List,Read,Write,Edit,Test,Finish}, Action::parse) through the
//!   Hub permission layer is a later step; this module only transports.
//! - Per AGENTS.md this is a separate execution mode (pi owns the agent
//!   loop, Hub owns tool execution + permissions), so it deliberately does
//!   not live inside dev_cli.rs's provider-harness connector path.

// The session API is consumed by a later wiring change; until then only the
// tests touch it, and the lib build would flag the whole surface as dead.
#![cfg_attr(not(test), allow(dead_code))]

use crate::agent_tools::{self, Action, Files, Kind};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

const SESSION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(60);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const EXIT_GRACE: Duration = Duration::from_secs(2);
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const STDERR_TAIL_LINES: usize = 40;
const WRITER_QUEUE: usize = 64;
const IMAGE_CHUNK_BYTES: usize = 192 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGE_REFS: usize = 4;

/// Private initialization bytes. Intentionally neither Debug nor serializable.
pub(crate) struct ImageTransfer {
    pub id: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub sha256: String,
    pub data_base64: String,
}

type ConfirmedFrame = (String, oneshot::Sender<Result<(), ()>>);

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Process spawn recipe. `args` are passed as an argv array, never a shell.
#[derive(Clone, Debug)]
pub struct SidecarSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub workspace: PathBuf,
    /// Extra environment for the child only (e.g. the advertised tool
    /// surface). The rest of the environment is inherited as usual.
    pub env: Vec<(String, String)>,
}

/// Where Node keeps compiled code for the sidecar bundle (about 14MB), so later runs skip most of the
/// parse and compile step (measured 0.58s -> 0.43s per start). Only for `node`; an explicit
/// NODE_COMPILE_CACHE in the spec or the operator's environment wins. Node keys the cache by file
/// content and its own version, so a changed bundle never runs stale code.
pub(crate) fn node_compile_cache(spec: &SidecarSpec) -> Option<PathBuf> {
    if spec.program.file_stem().and_then(|stem| stem.to_str()) != Some("node") { return None; }
    if spec.env.iter().any(|(name, _)| name == "NODE_COMPILE_CACHE") || std::env::var_os("NODE_COMPILE_CACHE").is_some() { return None; }
    let base = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(base).join("jkamma-hub").join("pi-compile-cache"))
}

/// One tool advertised by the sidecar's `hello` frame.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SidecarTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: Value,
}

/// Requested/effective local comparison settings. No provider fallback or defaults.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", try_from = "GenerationProfileInput")]
pub struct GenerationProfile {
    pub temperature: f64,
    pub max_tokens: u32,
    pub reasoning: GenerationReasoning,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GenerationReasoning { Off, Minimal, Low, Medium, High, Xhigh, Max }

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationProfileInput {
    temperature: f64,
    max_tokens: u32,
    reasoning: GenerationReasoning,
}

impl GenerationProfile {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !self.temperature.is_finite() || !(0.0..=2.0).contains(&self.temperature)
            || !(1..=8192).contains(&self.max_tokens) {
            return Err("pi_work_comparison_generation_invalid".into());
        }
        Ok(())
    }
}
impl TryFrom<GenerationProfileInput> for GenerationProfile {
    type Error = String;
    fn try_from(raw: GenerationProfileInput) -> Result<Self, Self::Error> {
        let profile = Self { temperature: raw.temperature, max_tokens: raw.max_tokens, reasoning: raw.reasoning };
        profile.validate()?;
        Ok(profile)
    }
}

/// Snapshot of the `hello` handshake, kept for `session.tools()` consumers.
#[derive(Clone, Debug)]
pub struct HelloInfo {
    pub generation: Option<GenerationProfile>,
    pub supports_steering: bool,
    pub proto: u64,
    pub active_tools: Vec<String>,
    pub tools: Vec<SidecarTool>,
    /// The "provider/id" the sidecar actually resolved; `None` on older
    /// bundles and on a resolution failure.
    pub model: Option<String>,
    /// On a resolution failure, the "provider/id" specs the registry did
    /// offer — the panel's picker data, kept for diagnostics.
    pub available: Option<Vec<String>>,
}

/// What a successful executor call becomes on the wire (`tool_result`).
#[derive(Debug)]
pub struct ToolAnswer {
    /// Model-visible content blocks, e.g. [{"type":"text","text":"..."}].
    pub content: Value,
    /// Structured UI/log-only details.
    pub details: Value,
    pub usage: Option<Value>,
    pub terminate: Option<bool>,
}

impl ToolAnswer {
    pub fn new(content: Value, details: Value) -> Self {
        Self {
            content,
            details,
            usage: None,
            terminate: None,
        }
    }
    /// Convenience for the common single text-block result.
    pub fn text(body: impl Into<String>) -> Self {
        Self::new(
            serde_json::json!([{ "type": "text", "text": body.into() }]),
            serde_json::json!({}),
        )
    }
}

/// Hub's half of a tool call. `Err` is sent back as `tool_error`.
///
/// Implementations must treat a dropped future as the abort signal: cancel
/// and per-call timeout both stop the work by dropping it. The future is
/// `Send` because it runs on the transport task.
pub trait ToolExecutor: Send + Sync {
    fn execute(&self, name: String, args: Value) -> BoxFuture<'static, Result<ToolAnswer, String>>;
}

impl<F, Fut> ToolExecutor for F
where
    F: Fn(String, Value) -> Fut + Send + Sync,
    Fut: Future<Output = Result<ToolAnswer, String>> + Send + 'static,
{
    fn execute(&self, name: String, args: Value) -> BoxFuture<'static, Result<ToolAnswer, String>> {
        Box::pin(self(name, args))
    }
}

/// Executor that delegates `tool_call` frames to `agent_tools`, read-only.
///
/// Equivalent to `agent_tools_executor_with_write(workspace, false)`.
pub fn agent_tools_executor(workspace: PathBuf) -> Arc<dyn ToolExecutor> {
    agent_tools_executor_with_write(workspace, false)
}

/// Run-level opt-ins for the operator-only tools. All are off by default
/// and none is ever covered by the `allow_write` session grant: every
/// `hub_exec`/`hub_http`/`hub_test` call parks on an individual operator
/// decision because each is arbitrary code execution or network egress.
/// `test` is environment-gated — set only when the pinned offline Docker
/// harness is available — so it is never an operator flag.
#[derive(Clone, Copy, Debug, Default)]
pub struct HubToolCaps {
    pub exec: bool,
    pub http: bool,
    pub test: bool,
    /// Thin engine only: Pi's native file tools reach the workspace through `hub_fs`.
    pub native_fs: bool,
}

/// Executor that delegates `tool_call` frames to `agent_tools`.
///
/// `hub_list` and `hub_read` run through the real workspace path validation.
/// With `allow_write`, `hub_write`/`hub_edit` apply the proposed change via
/// `Files::preview*` → `Files::write` — read-before-write tracking and a
/// `file_changed_since_approval` re-check. The flag is the session-level
/// grant: the caller (a local-window command) is itself the operator
/// approval, mirroring `start_dev_run`. Without it, mutating kinds are
/// refused as `write_not_permitted` before payload validation — the refusal
/// is a permission decision, not a complaint about the proposal's shape.
/// `hub_finish` answers `terminate` — session control, not a write.
///
/// `workspace` must be the same root passed to `SidecarSpec::workspace`;
/// `agent_tools` confines every path under it. The shared `Files` tracks
/// observed contents across the session. Calls are synchronous and bounded
/// by `agent_tools::MAX_FILE_BYTES`. For per-action operator approval
/// instead of a blanket refusal, see `agent_tools_executor_with_approval`.
pub fn agent_tools_executor_with_write(
    workspace: PathBuf,
    allow_write: bool,
) -> Arc<dyn ToolExecutor> {
    agent_tools_executor_with_approval(workspace, allow_write, None)
}

/// A mutation the operator is asked to rule on. `summary` is built from the
/// parsed action — a malformed proposal never becomes a request, so a human
/// only ever sees a description of a valid one.
#[derive(Clone, Debug)]
pub struct PiApprovalRequest {
    /// Wire tool name, e.g. "hub_write".
    pub tool: String,
    /// One human-readable line, e.g. "write notes.txt (42 bytes)".
    pub summary: String,
    /// Runtime-produced file preview, parsed operator/test request, or the
    /// purchase spec for `hub_pay`. This is ephemeral approval data.
    pub detail: Value,
}

/// What the decision channel resolves. `outcome` carries the result a tool
/// execution produced outside the desktop — for `hub_pay`, the Hub app's
/// order result the paired panel fetched after the operator approved.
#[derive(Clone, Debug)]
pub struct PiDecision {
    pub approved: bool,
    pub outcome: Option<Value>,
}

/// Operator decision callback. The executor awaits the returned future;
/// `approved: false` — or the future being dropped with the call — refuses
/// the mutation. It is data about a proposal, never authority: approving
/// still runs the ordinary preview→write validation.
pub type PiApprover = Arc<
    dyn Fn(PiApprovalRequest) -> Pin<Box<dyn Future<Output = PiDecision> + Send>> + Send + Sync,
>;

/// `agent_tools_executor_with_write` plus per-action operator approval.
///
/// Without `allow_write`, a parsed `hub_write`/`hub_edit` proposal goes to
/// `approver` instead of failing `write_not_permitted`: deny answers
/// `approval_denied`, approve runs the same preview→write path as the
/// session grant. Parsing still comes first — `invalid_action` /
/// `edit_invalid` payloads are refused before any human is asked. Read
/// kinds, `hub_test` and `hub_finish` never ask. `approver: None` is exactly
/// `agent_tools_executor_with_write`.
pub fn agent_tools_executor_with_approval(
    workspace: PathBuf,
    allow_write: bool,
    approver: Option<PiApprover>,
) -> Arc<dyn ToolExecutor> {
    hub_executor(workspace, allow_write, HubToolCaps::default(), approver)
}

/// The full executor: workspace file tools plus the operator-gated
/// `hub_exec`/`hub_http` surface selected by `caps`.
///
/// `hub_exec` and `hub_http` are never covered by `allow_write` — a blanket
/// file grant says nothing about running arbitrary commands or sending
/// arbitrary requests. Each call parses fully, then parks on `approver`
/// with the complete command line or request shown; deny answers
/// `approval_denied`, a missing approver answers `approval_required`, and a
/// disabled capability answers `exec_not_permitted`/`http_not_permitted`
/// before any parsing. Approving runs `agent_exec` with its own bounds
/// (workspace-confined cwd, curated environment, capped output, no redirect
/// following).
pub fn hub_executor(
    workspace: PathBuf,
    allow_write: bool,
    caps: HubToolCaps,
    approver: Option<PiApprover>,
) -> Arc<dyn ToolExecutor> {
    hub_executor_with_files(workspace, allow_write, caps, approver, Files::default())
}

/// Records actual successful file changes without changing permissions or answers.
pub fn hub_executor_with_changes(
    workspace: PathBuf,
    allow_write: bool,
    caps: HubToolCaps,
    approver: Option<PiApprover>,
    observer: Arc<dyn Fn(agent_tools::Change) + Send + Sync>,
) -> Arc<dyn ToolExecutor> {
    hub_executor_with_files(workspace, allow_write, caps, approver, Files::with_change_observer(observer))
}

fn hub_executor_with_files(
    workspace: PathBuf,
    allow_write: bool,
    caps: HubToolCaps,
    approver: Option<PiApprover>,
    files: Files,
) -> Arc<dyn ToolExecutor> {
    hub_executor_sharing_files(workspace, allow_write, caps, approver, Arc::new(Mutex::new(files)))
}

/// `hub_executor` over a caller-held `Files`, so the run can checkpoint the
/// observation hashes (`Files::observation_hashes`) and seed a resumed run
/// with `Files::restore_observations`. Permissions are unchanged.
pub fn hub_executor_sharing_files(
    workspace: PathBuf,
    allow_write: bool,
    caps: HubToolCaps,
    approver: Option<PiApprover>,
    files: Arc<Mutex<Files>>,
) -> Arc<dyn ToolExecutor> {
    Arc::new(move |name: String, args: Value| {
        let workspace = workspace.clone();
        let files = Arc::clone(&files);
        let approver = approver.clone();
        async move { run_agent_tool(&workspace, &files, &name, args, allow_write, caps, approver).await }
    })
}

/// `hub_exec`/`hub_http` dispatch. These tools have no session grant at all:
/// every call is a parsed proposal parked on an operator decision, and the
/// approval summary carries the entire command line or request so nothing
/// rides past review inside a field.
async fn run_operator_tool(
    name: &str,
    args: Value,
    workspace: &std::path::Path,
    caps: HubToolCaps,
    approver: Option<PiApprover>,
) -> Result<ToolAnswer, String> {
    let enabled = match name {
        "hub_exec" => caps.exec,
        "hub_http" => caps.http,
        _ => false,
    };
    if !enabled {
        return Err(if name == "hub_exec" {
            "exec_not_permitted".into()
        } else {
            "http_not_permitted".into()
        });
    }
    enum Call {
        Exec(crate::agent_exec::ExecRequest),
        Http(crate::agent_exec::HttpRequest),
    }
    let call = match name {
        "hub_exec" => Call::Exec(crate::agent_exec::ExecRequest::parse(args)?),
        _ => Call::Http(crate::agent_exec::HttpRequest::parse(args)?),
    };
    let summary = match &call {
        Call::Exec(request) => request.describe(),
        Call::Http(request) => request.describe(),
    };
    let detail = match &call {
        Call::Exec(request) => request.approval_detail(),
        Call::Http(request) => json!({"kind":"http","method":request.method.as_str(),"url":request.url.as_str(),
            "headers":request.headers.iter().map(|(name,value)|(name.as_str(),value)).collect::<Vec<_>>(),
            "body":request.body,"timeoutMs":request.timeout.as_millis()}),
    };
    let Some(approver) = approver else {
        return Err("approval_required".into());
    };
    let approved = approver(PiApprovalRequest {
        tool: name.to_owned(),
        summary,
        detail,
    })
    .await
    .approved;
    if !approved {
        return Err("approval_denied".into());
    }
    let result = match call {
        Call::Exec(request) => execution_result("command_failed", request.run(workspace).await?)?,
        Call::Http(request) => request.fetch().await?,
    };
    Ok(ToolAnswer::new(
        json!([{ "type": "text", "text": result.to_string() }]),
        result,
    ))
}

/// `hub_web_search`: exists only with the run's `allowHttp` (the same egress
/// switch as `hub_http`), and every call parks on an individual decision that
/// shows the query and the engines. Fixed engines and hosts only; see
/// `web_search.rs`. A missing approver answers `approval_required`.
async fn run_web_search_tool(
    args: Value,
    caps: HubToolCaps,
    approver: Option<PiApprover>,
) -> Result<ToolAnswer, String> {
    if !caps.http {
        return Err("http_not_permitted".into());
    }
    let key = crate::web_search::brave_key();
    let request = crate::web_search::SearchRequest::parse(&args, key.is_some())?;
    let approve = approver.map(|approver| {
        move |summary: String, detail: Value| async move {
            approver(PiApprovalRequest { tool: "hub_web_search".to_owned(), summary, detail }).await.approved
        }
    });
    let result = crate::web_search::approved_search(request, approve, key, crate::web_search::network_fetcher()).await?;
    Ok(ToolAnswer::new(json!([{ "type": "text", "text": result.to_string() }]), result))
}

// The transport succeeding does not mean the command/test passed. Keep the
// real diagnostics in Pi's isError result so its own loop can act on them.
fn execution_result(error: &str, result: Value) -> Result<Value, String> {
    if result["exitCode"].as_i64() != Some(0) || result["timedOut"].as_bool() != Some(false) {
        return Err(format!("{error}: {result}"));
    }
    Ok(result)
}

/// `hub_pay` parks a purchase proposal on the operator — there is no session
/// grant and no capability flag; advertising the tool confers nothing and
/// every call asks. Approving does not move funds inside the desktop: the
/// paired Hub panel reads the purchase spec from the request's `detail`,
/// executes the order through the operator's payment account, and resolves
/// the decision with the order outcome, which becomes this call's result.
async fn run_pay_tool(args: Value, approver: Option<PiApprover>) -> Result<ToolAnswer, String> {
    let request = crate::agent_exec::PayRequest::parse(args)?;
    let Some(approver) = approver else {
        return Err("approval_required".into());
    };
    let decision = approver(PiApprovalRequest {
        tool: "hub_pay".into(),
        summary: request.describe(),
        detail: request.detail(),
    })
    .await;
    if !decision.approved {
        return Err("approval_denied".into());
    }
    let outcome = decision.outcome.filter(|value| !value.is_null())
        .ok_or("purchase_outcome_missing")?;
    Ok(ToolAnswer::new(
        json!([{ "type": "text", "text": outcome.to_string() }]),
        outcome,
    ))
}

/// Test-runner output cap: the pinned harness returns full stdout/stderr,
/// which a runaway script could flood; keep the same head the Work loop
/// showed the operator.
fn bounded(value: &str) -> String {
    const LIMIT: usize = 8_192;
    if value.len() <= LIMIT {
        return value.into();
    }
    // The cap is bytes but the output is UTF-8: a limit landing inside a
    // multibyte char must back off to the boundary rather than panic.
    let mut end = LIMIT;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output truncated]", &value[..end])
}

/// The description a human approves or denies, derived only from
/// parsed fields. The model's own `summary` rides along as stated intent —
/// display data, not evidence.
fn approval_summary(action: &Action) -> String {
    let base = match action.kind {
        Kind::Write => format!("write {} ({} bytes)", action.path, action.content.len()),
        Kind::Edit => format!("edit {}", action.path),
        Kind::Test => format!(
            "test {}",
            json!({
                "language": action.path,
                "content": action.content,
                "timeoutMs": 30_000,
            })
        ),
        _ => action.path.clone(), // only mutating kinds reach approval
    };
    if action.summary.is_empty() {
        base
    } else {
        format!("{base} — {}", action.summary)
    }
}

async fn run_agent_tool(
    workspace: &std::path::Path,
    files: &Arc<Mutex<Files>>,
    name: &str,
    args: Value,
    allow_write: bool,
    caps: HubToolCaps,
    approver: Option<PiApprover>,
) -> Result<ToolAnswer, String> {
    if matches!(name, "hub_exec" | "hub_http") {
        return run_operator_tool(name, args, workspace, caps, approver).await;
    }
    if name == "hub_web_search" {
        return run_web_search_tool(args, caps, approver).await;
    }
    if name == "hub_pay" {
        return run_pay_tool(args, approver).await;
    }
    if matches!(name, "hub_catalog_search" | "hub_product_read") {
        // Read-only public catalog data; the text is untrusted model input.
        let result = if name == "hub_catalog_search" {
            crate::agent_market::catalog_search(args).await?
        } else {
            crate::agent_market::product_read(args).await?
        };
        return Ok(ToolAnswer::new(
            json!([{ "type": "text", "text": result.to_string() }]),
            result,
        ));
    }
    if matches!(name, "hub_search" | "hub_read_range") {
        let workspace = workspace.to_path_buf();
        let search = name == "hub_search";
        let result = tokio::task::spawn_blocking(move || {
            if search {
                crate::agent_discovery::search(&workspace, args)
            } else {
                crate::agent_discovery::read_range(&workspace, args)
            }
        })
        .await
        .map_err(|_| "discovery_internal".to_owned())??;
        return Ok(ToolAnswer::new(
            json!([{ "type": "text", "text": result.to_string() }]),
            result,
        ));
    }
    if matches!(name, "hub_fs" | "hub_fs_write") {
        // Thin engine: Pi's native tools do their file IO only through these.
        if !caps.native_fs {
            return Err("unknown_tool".into());
        }
        let workspace = workspace.to_path_buf();
        if name == "hub_fs" {
            let files = Arc::clone(files);
            return tokio::task::spawn_blocking(move || {
                let answer = crate::agent_native::read_op(&workspace, &args)?;
                // A whole-file read is recorded (path + SHA-256) for resume checkpoints.
                if let (Some(path), Some(content)) = (answer.details["relativePath"].as_str(), answer.details["content"].as_str()) {
                    files.lock().map_err(|_| "files_poisoned".to_owned())?.record_native_read(path, content);
                }
                Ok(answer)
            })
            .await
            .map_err(|_| "exec_internal".to_owned())?;
        }
        let gated = !allow_write;
        if gated && approver.is_none() {
            return Err("write_not_permitted".into());
        }
        let plan = {
            let (workspace, files, args) = (workspace.clone(), Arc::clone(files), args.clone());
            tokio::task::spawn_blocking(move || {
                let files = files.lock().map_err(|_| "files_poisoned".to_owned())?;
                crate::agent_native::plan_write(&workspace, &files, &args)
            })
            .await
            .map_err(|_| "exec_internal".to_owned())??
        };
        let needs_approval = gated && !matches!(plan, crate::agent_native::WriteOp::Mkdir { needed: false, .. });
        if needs_approval {
            let (summary, detail) = match &plan {
                crate::agent_native::WriteOp::Write(change) => (
                    format!("write {} ({} bytes)", change.path, change.after.len()),
                    json!(change),
                ),
                crate::agent_native::WriteOp::Mkdir { rel, .. } => (format!("create folder {rel}"), json!({"kind":"mkdir","path":rel})),
            };
            let approver = approver.expect("checked above");
            if !approver(PiApprovalRequest { tool: "hub_write".into(), summary, detail }).await.approved {
                return Err("approval_denied".into());
            }
        }
        let files = Arc::clone(files);
        let result = tokio::task::spawn_blocking(move || {
            let mut files = files.lock().map_err(|_| "files_poisoned".to_owned())?;
            crate::agent_native::apply_write(&workspace, &mut files, plan)
        })
        .await
        .map_err(|_| "exec_internal".to_owned())??;
        return Ok(ToolAnswer::new(json!([{ "type": "text", "text": result.to_string() }]), result));
    }
    let kind = match name {
        "hub_list" => Kind::List,
        "hub_read" => Kind::Read,
        "hub_write" => Kind::Write,
        "hub_edit" => Kind::Edit,
        "hub_test" => Kind::Test,
        "hub_finish" => {
            let mut answer = ToolAnswer::text("run finished");
            answer.terminate = Some(true);
            return Ok(answer);
        }
        _ => return Err("unknown_tool".into()),
    };
    // `hub_test` runs inside the pinned offline Docker harness against a
    // snapshot of observed files only. The capability is environmental
    // (`caps.test`); the refusal is a permission decision, so it precedes
    // payload validation like the write gate.
    if kind == Kind::Test && !caps.test {
        return Err("test_not_permitted".into());
    }
    let gated = matches!(kind, Kind::Write | Kind::Edit) && !allow_write;
    // Code execution always parks on an individual decision — there is no
    // session grant for `hub_test`, same as `hub_exec`/`hub_http`.
    let needs_approval = gated || kind == Kind::Test;
    if needs_approval && approver.is_none() {
        return Err(if kind == Kind::Test {
            "approval_required".into()
        } else {
            "write_not_permitted".into()
        });
    }
    let mut value = match args {
        Value::Object(_) => args,
        _ => return Err("invalid_action".into()),
    };
    let map = value.as_object_mut().expect("checked object");
    // hub_read may ask for a line range; it is not part of the Action wire form.
    let mut range = (None, None);
    if kind == Kind::Read {
        for (slot, key, max) in [(&mut range.0, "startLine", 10_000_000), (&mut range.1, "lineCount", 2_000)] {
            match map.remove(key) {
                None | Some(Value::Null) => {}
                Some(value) => match value.as_u64() {
                    Some(n) if (1..=max).contains(&n) => *slot = Some(n as usize),
                    _ => return Err("invalid_read_range".into()),
                },
            }
        }
    }
    map.insert("kind".into(), json!(kind));
    for field in ["path", "content", "summary"] {
        map.entry(field.to_owned()).or_insert_with(|| json!(""));
    }
    let action = Action::parse(value)?;
    let approved_change = if gated {
        let workspace = workspace.to_path_buf();
        let files = Arc::clone(files);
        let action = action.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                let files = files.lock().map_err(|_| "files_poisoned".to_owned())?;
                if action.kind == Kind::Edit {
                    files.preview_edit(&workspace, &action.path, &action.content)
                } else {
                    files.preview(&workspace, &action.path, &action.content)
                }
            })
            .await
            .map_err(|_| "exec_internal".to_owned())??,
        )
    } else {
        None
    };
    if needs_approval {
        // Only a valid proposal is worth a human decision; the approver runs
        // after previewing and releasing `files`; the wait holds no mutex.
        let approver = approver.expect("gated without approver returned above");
        let approved = approver(PiApprovalRequest {
            tool: name.to_string(),
            summary: approval_summary(&action),
            detail: if kind == Kind::Test {
                json!({"kind":"test","language":action.path,"content":action.content,"timeoutMs":30_000})
            } else { json!(approved_change.as_ref()) },
        })
        .await
        .approved;
        if !approved {
            return Err("approval_denied".into());
        }
    }
    // File work is synchronous: canonicalize/stat/reads up to the size cap
    // run while the `files` mutex serializes revisions. Keep that blocking
    // IO off the async worker so concurrent tool calls cannot stall the
    // transport loop.
    let result = match action.kind {
        Kind::Test => {
            let snapshot = {
                let workspace = workspace.to_path_buf();
                let files = Arc::clone(files);
                tokio::task::spawn_blocking(move || {
                    files
                        .lock()
                        .map_err(|_| "files_poisoned".to_owned())?
                        .snapshot(&workspace)
                })
                .await
                .map_err(|_| "exec_internal".to_owned())??
            };
            let output = crate::docker::execute(
                &uuid::Uuid::new_v4().to_string(),
                &action.path,
                action.content.clone(),
                &snapshot.path,
                30_000,
            )
            .await?;
            execution_result(
                "test_failed",
                json!({
                    "exitCode": output.exit_code,
                    "timedOut": output.timed_out,
                    "stdout": bounded(&output.stdout),
                    "stderr": bounded(&output.stderr),
                    "scope": "observed_files_only",
                }),
            )?
        }
        _ => {
            let workspace = workspace.to_path_buf();
            let files = Arc::clone(files);
            tokio::task::spawn_blocking(move || match action.kind {
                Kind::List => agent_tools::list(&workspace, &action.path),
                Kind::Read => files
                    .lock()
                    .map_err(|_| "files_poisoned".to_owned())?
                    .read_page(&workspace, &action.path, range.0, range.1),
                _ => {
                    let mut files = files.lock().map_err(|_| "files_poisoned".to_owned())?;
                    let change = if let Some(change) = approved_change {
                        change
                    } else if action.kind == Kind::Edit {
                        files.preview_edit(&workspace, &action.path, &action.content)?
                    } else {
                        files.preview(&workspace, &action.path, &action.content)?
                    };
                    files.write(&workspace, &change)
                }
            })
            .await
            .map_err(|_| "exec_internal".to_owned())??
        }
    };
    let text = result
        .get("content")
        .and_then(|content| content.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| result.to_string());
    Ok(ToolAnswer::new(
        json!([{ "type": "text", "text": text }]),
        result,
    ))
}

/// Optional observability mirror for session lifecycle frames.
#[derive(Clone, Debug)]
pub enum SessionEvent {
    Hello {
        generation: Option<GenerationProfile>,
        supports_steering: bool,
        proto: u64,
        active_tools: Vec<String>,
        /// Resolved "provider/id" — absent on older bundles.
        model: Option<String>,
        /// What the registry offered when resolution failed.
        available: Option<Vec<String>>,
    },
    AgentEvent(Value),
    /// One streamed assistant-text delta from a `partial` frame — the
    /// sidecar's compact answer to `message_update` noise.
    PartialOutput {
        text: String,
    },
    ToolCallStarted {
        id: String,
        name: String,
        /// Compact locator for the call's target — a workspace path, command
        /// line, URL or search query — so observers can show *what* is being
        /// acted on, not just the tool name. Metadata, not content.
        detail: Option<String>,
    },
    ToolCallSettled {
        id: String,
        ok: bool,
        /// Bounded excerpt of the tool result (or error) for the live run
        /// view. Content-class data: run state keeps it in memory and the
        /// encrypted checkpoint, but `pi_work` strips it from JSONL history
        /// the same way it strips `final_output`.
        preview: Option<String>,
    },
}

/// The one argument that identifies what a call acts on — shown beside the
/// tool name in the run view. Bounded to one sanitized line.
const MAX_TOOL_DETAIL_CHARS: usize = 120;

fn tool_call_detail(name: &str, args: &Value) -> Option<String> {
    let text = |key: &str| args.get(key)?.as_str();
    let raw = match name {
        "hub_write" | "hub_edit" | "hub_test" => text("path").map(str::to_owned),
        "hub_read" | "hub_read_range" => text("path").map(|path| {
            match args.get("startLine").and_then(Value::as_u64) {
                Some(start) if start > 1 => format!("{path}:{start}"),
                _ => path.to_owned(),
            }
        }),
        "hub_list" => text("path").map(|path| {
            if path.is_empty() {
                ".".to_owned()
            } else {
                path.to_owned()
            }
        }),
        "hub_search" => text("query").map(|query| format!("\"{query}\"")),
        "hub_exec" => text("program").map(|program| {
            let argv = args
                .get("args")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            match (program, argv.trim()) {
                (program, "") => program.to_owned(),
                (program, argv) => format!("{program} {argv}"),
            }
        }),
        "hub_http" => match (text("method"), text("url")) {
            (Some(method), Some(url)) => Some(format!("{method} {url}")),
            (method, url) => url.or(method).map(str::to_owned),
        },
        "hub_web_search" => text("query").map(str::to_owned),
        "hub_pay" => text("note").or_else(|| text("productId")).map(str::to_owned),
        _ => None,
    }?;
    let clean: String = raw
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_TOOL_DETAIL_CHARS)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        None
    } else {
        Some(clean.to_owned())
    }
}

/// First text block of a tool result, bounded — enough for the operator to
/// recognize what came back without mirroring whole files into the run view.
const MAX_TOOL_PREVIEW_CHARS: usize = 400;

fn result_preview(answer: &Result<ToolAnswer, String>) -> Option<String> {
    let text = match answer {
        Ok(answer) => answer
            .content
            .as_array()?
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .next()?
            .to_owned(),
        Err(message) => message.clone(),
    };
    let mut chars = text.chars();
    let mut preview: String = chars.by_ref().take(MAX_TOOL_PREVIEW_CHARS).collect();
    if chars.next().is_some() {
        preview.push('…');
    }
    if preview.trim().is_empty() {
        None
    } else {
        Some(preview)
    }
}

/// Injected collaborators. The executor is the future `agent_tools` wiring
/// point; the observer is a cheap, synchronous observability tap.
#[derive(Clone)]
pub struct SidecarHooks {
    pub executor: Arc<dyn ToolExecutor>,
    /// Conversation data only, never permissions or file observations.
    pub on_checkpoint: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    pub on_event: Option<Arc<dyn Fn(SessionEvent) + Send + Sync>>,
    /// Per stderr line, for run-state watchers — diagnostics live in the
    /// tail deque, so the hook carries no payload, just "something changed".
    pub on_stderr: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl SidecarHooks {
    pub fn new(executor: Arc<dyn ToolExecutor>) -> Self {
        Self {
            executor,
            on_checkpoint: None,
            on_event: None,
            on_stderr: None,
        }
    }
    pub fn with_observer(mut self, observer: Arc<dyn Fn(SessionEvent) + Send + Sync>) -> Self {
        self.on_event = Some(observer);
        self
    }
    pub fn with_stderr_notify(mut self, hook: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.on_stderr = Some(hook);
        self
    }
}

/// Deadlines. Defaults match a real agent session; tests shrink them.
#[derive(Clone, Copy, Debug)]
pub struct SidecarLimits {
    /// Whole-conversation ceiling.
    pub session: Duration,
    /// Per-tool_call ceiling before the call is answered with tool_error.
    pub tool_call: Duration,
    /// Grace between `agent_done` and expected EOF before we stop waiting.
    pub drain: Duration,
}

impl Default for SidecarLimits {
    fn default() -> Self {
        Self {
            session: SESSION_TIMEOUT,
            tool_call: TOOL_CALL_TIMEOUT,
            drain: DRAIN_TIMEOUT,
        }
    }
}

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("sidecar spawn failed: {0}")]
    Spawn(String),
    #[error("sidecar protocol error: {0}")]
    Protocol(String),
    #[error("sidecar transport error: {0}")]
    Transport(String),
    #[error("sidecar session timed out")]
    Timeout,
    #[error("sidecar stream ended before agent_done")]
    Interrupted,
    #[error("sidecar internal error: {0}")]
    Internal(String),
}

/// Final session state reported by `wait`.
#[derive(Clone, Debug)]
pub struct SidecarOutcome {
    /// The `ok` flag from the agent_done frame.
    pub ok: bool,
    /// Child exit code when the process has been reaped; `None` if it had to
    /// be killed or the session ran in-memory.
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Wire frames

fn session_frame(entries: Value, workspace_map: Value, verification: Option<Value>,
    generation: Option<GenerationProfile>) -> Result<String, SidecarError> {
    let mut frame = json!({"type":"session", "entries":entries, "workspaceMap":workspace_map, "verification":verification});
    if let Some(generation) = generation {
        generation.validate().map_err(|_| SidecarError::Protocol("comparison generation invalid".into()))?;
        frame["generation"] = serde_json::to_value(generation)
            .map_err(|_| SidecarError::Protocol("comparison generation invalid".into()))?;
    }
    Ok(frame.to_string())
}

fn image_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36 && bytes[14] == b'4' && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| if [8, 13, 18, 23].contains(&index) {
            *byte == b'-'
        } else { byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f') })
}

fn image_session_frame(entries: Value, workspace_map: Value, verification: Option<Value>,
    generation: Option<GenerationProfile>, images: &[ImageTransfer], prompt_image_ids: &[String])
    -> Result<(String, Vec<Vec<u8>>), SidecarError> {
    let invalid = || SidecarError::Protocol("image initialization invalid".into());
    if images.len() > MAX_IMAGE_REFS || prompt_image_ids.len() > 1
        || prompt_image_ids.iter().any(|id| !image_id(id) || !images.iter().any(|image| image.id == *id)) {
        return Err(invalid());
    }
    let mut decoded = Vec::with_capacity(images.len());
    let mut refs = Vec::with_capacity(images.len());
    let mut total = 0usize;
    for (index, image) in images.iter().enumerate() {
        if !image_id(&image.id) || images[..index].iter().any(|earlier| earlier.id == image.id)
            || !matches!(image.mime_type.as_str(), "image/png" | "image/jpeg")
            || image.size_bytes == 0 || image.size_bytes > MAX_IMAGE_BYTES
            || image.data_base64.len() > 4 * MAX_IMAGE_BYTES.div_ceil(3)
            || image.sha256.len() != 64
            || !image.sha256.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')) {
            return Err(invalid());
        }
        let bytes = BASE64.decode(&image.data_base64).map_err(|_| invalid())?;
        if bytes.len() != image.size_bytes || BASE64.encode(&bytes) != image.data_base64
            || format!("{:x}", Sha256::digest(&bytes)) != image.sha256 {
            return Err(invalid());
        }
        total = total.checked_add(bytes.len()).ok_or_else(invalid)?;
        if total > MAX_IMAGE_REFS * MAX_IMAGE_BYTES { return Err(invalid()); }
        refs.push(json!({"id":image.id,"mimeType":image.mime_type,"sizeBytes":image.size_bytes,"sha256":image.sha256}));
        decoded.push(bytes);
    }
    let mut frame: Value = serde_json::from_str(&session_frame(entries, workspace_map, verification, generation)?)
        .map_err(|_| invalid())?;
    if !images.is_empty() {
        frame["imageRefs"] = json!(refs);
        frame["promptImageIds"] = json!(prompt_image_ids);
    }
    let frame = frame.to_string();
    if frame.len() > MAX_FRAME_BYTES { return Err(SidecarError::Protocol("session exceeds size limit".into())); }
    Ok((frame, decoded))
}


// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum SidecarFrame {
    #[serde(rename = "image_inputs")]
    ImageInputs { #[serde(flatten)] input: ImageInputReceipt },
    #[serde(rename = "steer_ack")]
    SteerAck { #[serde(rename="requestId")] request_id:String, accepted:bool, #[serde(default)] code:Option<String> },
    #[serde(rename = "checkpoint")]
    Checkpoint { entries: Value },
    #[serde(rename = "hello")]
    Hello {
        #[serde(default)]
        generation: Option<GenerationProfile>,
        #[serde(default, rename="supportsSteering")]
        supports_steering: bool,
        proto: u64,
        #[serde(default, rename = "activeTools")]
        active_tools: Vec<String>,
        #[serde(default)]
        tools: Vec<SidecarTool>,
        /// Newer bundles report the resolved "provider/id", or null when the
        /// requested spec did not resolve. Older bundles omit it entirely.
        #[serde(default)]
        model: Option<String>,
        /// The registry's alternatives, sent on a resolution failure.
        #[serde(default)]
        available: Option<Vec<String>>,
    },
    #[serde(rename = "tool_call")]
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        args: Value,
    },
    #[serde(rename = "cancel")]
    Cancel { id: String },
    #[serde(rename = "event")]
    Event { event: Value },
    #[serde(rename = "partial")]
    Partial { text: String },
    #[serde(rename = "agent_done")]
    AgentDone { ok: bool },
}

#[derive(Debug)]
struct ImageInputReceipt { prompt_image_ids: Vec<String>, reattached_image_ids: Vec<String> }
impl<'de> Deserialize<'de> for ImageInputReceipt {
    fn deserialize<D:serde::Deserializer<'de>>(deserializer:D)->Result<Self,D::Error> {
        use serde::de::{Error as _,MapAccess,Visitor};
        struct ReceiptVisitor;
        impl<'de> Visitor<'de> for ReceiptVisitor {
            type Value=ImageInputReceipt;
            fn expecting(&self,formatter:&mut std::fmt::Formatter)->std::fmt::Result {formatter.write_str("image inputs")}
            fn visit_map<M:MapAccess<'de>>(self,mut map:M)->Result<Self::Value,M::Error> {
                let mut prompt:Option<Vec<String>>=None;let mut reattached:Option<Vec<String>>=None;
                // deserialize_struct filters flattened leftovers by known field names;
                // deserialize_map must inspect every key to keep this receipt closed.
                while let Some(key)=map.next_key::<String>().map_err(|_|M::Error::custom("image inputs invalid"))? {
                    match key.as_str() {
                        "promptImageIds" if prompt.is_none()=>prompt=Some(map.next_value().map_err(|_|M::Error::custom("image inputs invalid"))?),
                        "reattachedImageIds" if reattached.is_none()=>reattached=Some(map.next_value().map_err(|_|M::Error::custom("image inputs invalid"))?),
                        _=>return Err(M::Error::custom("image inputs invalid")),
                    }
                }
                let prompt_image_ids=prompt.ok_or_else(||M::Error::custom("image inputs invalid"))?;
                let reattached_image_ids=reattached.ok_or_else(||M::Error::custom("image inputs invalid"))?;
                if prompt_image_ids.len()>1 || reattached_image_ids.len()>MAX_IMAGE_REFS
                    || prompt_image_ids.iter().chain(reattached_image_ids.iter()).any(|id| !image_id(id))
                    || reattached_image_ids.iter().enumerate().any(|(index,id)| reattached_image_ids[..index].contains(id)) {
                    return Err(M::Error::custom("image inputs invalid"));
                }
                Ok(ImageInputReceipt {prompt_image_ids,reattached_image_ids})
            }
        }
        deserializer.deserialize_map(ReceiptVisitor).map_err(|_|D::Error::custom("image inputs invalid"))
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum HubFrame {
    #[serde(rename="steer")]
    Steer { #[serde(rename="requestId")] request_id:String, text:String },
    #[serde(rename = "tool_partial")]
    ToolPartial {
        id: String,
        content: Value,
        details: Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        id: String,
        content: Value,
        details: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        terminate: Option<bool>,
    },
    #[serde(rename = "tool_error")]
    ToolError { id: String, message: String },
}

fn encode(frame: &HubFrame) -> String {
    serde_json::to_string(frame).unwrap_or_else(|_| {
        r#"{"type":"tool_error","id":"","message":"frame encoding failed"}"#.to_string()
    })
}

// ---------------------------------------------------------------------------
// Transport core (process-agnostic; tests drive it over an in-memory duplex)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct SessionShared {
    ending: std::sync::atomic::AtomicBool,
    steering: Mutex<HashMap<String, oneshot::Sender<Result<(),SteerFailure>>>>,
    steering_known: Mutex<HashMap<String,SteerKnown>>,
    hello: Mutex<Option<HelloInfo>>,
    /// tool_call id -> cancel sender for the in-flight executor call.
    pending: Mutex<HashMap<String, oneshot::Sender<()>>>,
    writer_abort: Mutex<Option<tokio::task::AbortHandle>>,
}

struct TransportCore {
    shared: Arc<SessionShared>,
    writer: mpsc::Sender<String>,
    confirmed_writer: mpsc::Sender<ConfirmedFrame>,
    join: JoinHandle<Result<bool, SidecarError>>,
}

impl TransportCore {
    fn hello(&self) -> Option<HelloInfo> {
        self.shared.hello.lock().unwrap().clone()
    }

    async fn send_confirmed(&self, line: String) -> Result<(), SidecarError> {
        if self.shared.ending.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(SidecarError::Transport("image initialization stopped".into()));
        }
        if line.len() > MAX_FRAME_BYTES { return Err(SidecarError::Protocol("frame exceeds size limit".into())); }
        let (ack, receipt) = oneshot::channel();
        self.confirmed_writer.send((line, ack)).await
            .map_err(|_| SidecarError::Transport("writer closed".into()))?;
        receipt.await.map_err(|_| SidecarError::Transport("writer closed".into()))?
            .map_err(|_| SidecarError::Transport("writer failed".into()))?;
        Ok(())
    }

    async fn send_partial(
        &self,
        id: &str,
        content: Value,
        details: Value,
    ) -> Result<(), SidecarError> {
        let line = encode(&HubFrame::ToolPartial {
            id: id.to_string(),
            content,
            details,
        });
        self.writer
            .send(line)
            .await
            .map_err(|_| SidecarError::Transport("writer closed".into()))
    }

    async fn wait(self) -> Result<bool, SidecarError> {
        match self.join.await {
            Ok(result) => result,
            Err(error) => Err(SidecarError::Internal(format!("transport task: {error}"))),
        }
    }
}

fn emit(hooks: &SidecarHooks, event: SessionEvent) {
    if let Some(observer) = &hooks.on_event {
        observer(event);
    }
}

fn cancel_pending(shared: &SessionShared) {
    let senders: Vec<oneshot::Sender<()>> = shared
        .pending
        .lock()
        .unwrap()
        .drain()
        .map(|(_, tx)| tx)
        .collect();
    for tx in senders {
        let _ = tx.send(());
    }
}

fn attach<R, W>(reader: R, writer: W, hooks: SidecarHooks, limits: SidecarLimits) -> TransportCore
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let shared = Arc::new(SessionShared::default());
    let (writer_tx, writer_rx) = mpsc::channel::<String>(WRITER_QUEUE);
    let (confirmed_tx, confirmed_rx) = mpsc::channel::<ConfirmedFrame>(1);
    let join = tokio::spawn(run_transport(
        reader,
        writer,
        hooks,
        limits,
        shared.clone(),
        writer_tx.clone(),
        writer_rx,
        confirmed_rx,
    ));
    TransportCore {
        shared,
        writer: writer_tx,
        confirmed_writer: confirmed_tx,
        join,
    }
}

/// One tool_call -> one task. Cancel and timeout both abort the executor
/// future; whichever branch wins decides the single response frame.
fn spawn_tool_call(
    id: String,
    name: String,
    args: Value,
    hooks: &SidecarHooks,
    shared: &Arc<SessionShared>,
    writer: &mpsc::Sender<String>,
    timeout: Duration,
) -> Result<(), SidecarError> {
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut pending = shared.pending.lock().unwrap();
        if pending.contains_key(&id) {
            return Err(SidecarError::Protocol(format!(
                "duplicate tool_call id {id}"
            )));
        }
        pending.insert(id.clone(), cancel_tx);
    }
    let executor = hooks.executor.clone();
    let on_event = hooks.on_event.clone();
    let writer = writer.clone();
    let shared = shared.clone();
    let task_id = id.clone();
    tokio::spawn(async move {
        // The executor runs in its own task so a panic surfaces as a
        // JoinError we can translate, not a crash of the transport loop.
        let work = tokio::spawn(async move { executor.execute(name, args).await });
        let abort = work.abort_handle();
        let answer = tokio::select! {
            _ = cancel_rx => {
                abort.abort();
                Err("cancelled".to_string())
            }
            _ = tokio::time::sleep(timeout) => {
                abort.abort();
                Err(format!("tool call timed out after {}ms", timeout.as_millis()))
            }
            joined = work => match joined {
                Ok(answer) => answer,
                Err(error) => Err(if error.is_panic() {
                    "executor panicked".to_string()
                } else {
                    "executor aborted".to_string()
                }),
            },
        };
        shared.pending.lock().unwrap().remove(&task_id);
        let ok = answer.is_ok();
        let preview = result_preview(&answer);
        let frame = match answer {
            Ok(ToolAnswer {
                content,
                details,
                usage,
                terminate,
            }) => HubFrame::ToolResult {
                id: task_id.clone(),
                content,
                details,
                usage,
                terminate,
            },
            Err(message) => HubFrame::ToolError {
                id: task_id.clone(),
                message,
            },
        };
        let _ = writer.send(encode(&frame)).await;
        if let Some(observer) = on_event {
            observer(SessionEvent::ToolCallSettled {
                id: task_id,
                ok,
                preview,
            });
        }
    });
    Ok(())
}

async fn run_transport<R, W>(
    reader: R,
    writer: W,
    hooks: SidecarHooks,
    limits: SidecarLimits,
    shared: Arc<SessionShared>,
    writer_tx: mpsc::Sender<String>,
    mut writer_rx: mpsc::Receiver<String>,
    mut confirmed_rx: mpsc::Receiver<ConfirmedFrame>,
) -> Result<bool, SidecarError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    // Outbound frames funnel through one task so per-call tasks can answer
    // concurrently without interleaving bytes on the wire.
    let (write_fail_tx, mut write_fail_rx) = oneshot::channel::<String>();
    let writer_shared = Arc::clone(&shared);
    let mut writer_task = tokio::spawn(async move {
        let mut writer = writer;
        let mut confirmed_open = true;
        loop {
            let (mut line, ack) = tokio::select! {
                ordinary = writer_rx.recv() => match ordinary { Some(line) => (line, None), None => break },
                confirmed = confirmed_rx.recv(), if confirmed_open => match confirmed {
                    Some((line, ack)) => (line, Some(ack)),
                    None => { confirmed_open = false; continue; }
                },
            };
            if line.starts_with("{\"type\":\"steer\",") && writer_shared.ending.load(std::sync::atomic::Ordering::SeqCst) {continue;}
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
                if let Some(ack) = ack { let _ = ack.send(Err(())); }
                let _ = write_fail_tx.send("writer failed".to_string());
                return;
            }
            if let Some(ack) = ack { let _ = ack.send(Ok(())); }
        }
    });
    *shared.writer_abort.lock().unwrap() = Some(writer_task.abort_handle());

    let mut lines = BufReader::new(reader).lines();
    let session_deadline = tokio::time::sleep(limits.session);
    tokio::pin!(session_deadline);
    let drain_deadline = tokio::time::sleep(limits.drain);
    tokio::pin!(drain_deadline);
    let mut done: Option<bool> = None;

    let result: Result<bool, SidecarError> = loop {
        let line = tokio::select! {
            _ = &mut session_deadline, if done.is_none() => {
                break Err(SidecarError::Timeout);
            }
            _ = &mut drain_deadline, if done.is_some() => {
                break Ok(done.unwrap_or(false));
            }
            message = &mut write_fail_rx => {
                break Err(SidecarError::Transport(
                    message.unwrap_or_else(|_| "writer closed".into()),
                ));
            }
            line = lines.next_line() => line,
        };
        match line {
            Err(error) => {
                break Err(if error.kind() == std::io::ErrorKind::InvalidData {
                    SidecarError::Protocol("non-UTF-8 frame".into())
                } else {
                    SidecarError::Transport(error.to_string())
                });
            }
            Ok(None) => {
                break match done {
                    Some(ok) => Ok(ok),
                    None => Err(SidecarError::Interrupted),
                };
            }
            Ok(Some(line)) => {
                if line.len() > MAX_FRAME_BYTES {
                    break Err(SidecarError::Protocol("frame exceeds size limit".into()));
                }
                if done.is_some() {
                    if let Ok(SidecarFrame::SteerAck {request_id,accepted,code})=serde_json::from_str(&line) {
                        record_steer_ack(&shared,&request_id,accepted,code.as_deref());
                    }
                    continue; // trailing frames after agent_done carry nothing we need
                }
                let frame: SidecarFrame = match serde_json::from_str(&line) {
                    Ok(frame) => frame,
                    Err(_) => {
                        break Err(SidecarError::Protocol("invalid frame".to_owned()))
                    }
                };
                match frame {
                    SidecarFrame::SteerAck {request_id,accepted,code} => {
                        record_steer_ack(&shared,&request_id,accepted,code.as_deref());
                    }
                    SidecarFrame::Checkpoint { entries } => {
                        if let Some(save) = &hooks.on_checkpoint {
                            save(entries);
                        }
                    }
                    SidecarFrame::Hello {
                        generation,
                        supports_steering,
                        proto,
                        active_tools,
                        tools,
                        model,
                        available,
                    } => {
                        *shared.hello.lock().unwrap() = Some(HelloInfo {
                            generation: generation.clone(),
                            supports_steering,
                            proto,
                            active_tools: active_tools.clone(),
                            tools,
                            model: model.clone(),
                            available: available.clone(),
                        });
                        emit(
                            &hooks,
                            SessionEvent::Hello {
                                generation,
                                supports_steering,
                                proto,
                                active_tools,
                                model,
                                available,
                            },
                        );
                    }
                    SidecarFrame::ToolCall { id, name, args } => {
                        emit(
                            &hooks,
                            SessionEvent::ToolCallStarted {
                                id: id.clone(),
                                name: name.clone(),
                                detail: tool_call_detail(&name, &args),
                            },
                        );
                        if let Err(error) = spawn_tool_call(
                            id,
                            name,
                            args,
                            &hooks,
                            &shared,
                            &writer_tx,
                            limits.tool_call,
                        ) {
                            break Err(error);
                        }
                    }
                    SidecarFrame::Cancel { id } => {
                        let sender = shared.pending.lock().unwrap().remove(&id);
                        if let Some(tx) = sender {
                            let _ = tx.send(()); // stale/unknown ids are ignored by design
                        }
                    }
                    SidecarFrame::Event { event } => emit(&hooks, SessionEvent::AgentEvent(event)),
                    SidecarFrame::ImageInputs { input } => emit(&hooks,SessionEvent::AgentEvent(json!({"type":"image_inputs",
                        "promptImageIds":input.prompt_image_ids,"reattachedImageIds":input.reattached_image_ids}))),
                    SidecarFrame::Partial { text } => {
                        emit(&hooks, SessionEvent::PartialOutput { text })
                    }
                    SidecarFrame::AgentDone { ok } => {
                        stop_steering(&shared);
                        done = Some(ok);
                        drain_deadline
                            .as_mut()
                            .reset(tokio::time::Instant::now() + limits.drain);
                    }
                }
            }
        }
    };

    // In-flight calls are session work: cancel them, then let the writer
    // drain whatever they already queued before we report back.
    stop_steering(&shared);
    cancel_pending(&shared);
    drop(writer_tx);
    let _ = tokio::time::timeout(EXIT_GRACE, &mut writer_task).await;
    result
}

// ---------------------------------------------------------------------------
// Real child-process session: a thin spawn wrapper around the transport core
// ---------------------------------------------------------------------------

pub struct SidecarSession {
    core: TransportCore,
    child: Option<Child>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_task: Option<JoinHandle<()>>,
}

struct ImageInitializationGuard<'a> {
    core: &'a TransportCore,
    child: &'a mut Option<Child>,
    completed: bool,
}
impl Drop for ImageInitializationGuard<'_> {
    fn drop(&mut self) {
        if self.completed { return; }
        self.core.shared.ending.store(true, std::sync::atomic::Ordering::SeqCst);
        stop_steering(&self.core.shared);
        cancel_pending(&self.core.shared);
        if let Some(writer) = self.core.shared.writer_abort.lock().unwrap().as_ref() { writer.abort(); }
        self.core.join.abort();
        if let Some(child) = self.child.as_mut() { let _ = child.start_kill(); }
    }
}

impl SidecarSession {
    pub(crate) fn steering_handle(&self)->SidecarSteering {SidecarSteering{shared:Arc::clone(&self.core.shared),writer:self.core.writer.downgrade()}}
    /// Initialize a resumable SDK session over stdin, never argv or disk.
    pub async fn initialize(
        &self,
        entries: Value,
        workspace_map: Value,
        verification: Option<Value>,
    ) -> Result<(), SidecarError> {
        self.initialize_with_generation(entries, workspace_map, verification, None).await
    }

    pub(crate) async fn initialize_with_generation(&self, entries: Value,
        workspace_map: Value, verification: Option<Value>, generation: Option<GenerationProfile>)
        -> Result<(), SidecarError> {
        let frame = session_frame(entries, workspace_map, verification, generation)?;
        if frame.len() > MAX_FRAME_BYTES {
            return Err(SidecarError::Protocol("session exceeds size limit".into()));
        }
        self.core
            .writer
            .send(frame)
            .await
            .map_err(|_| SidecarError::Transport("writer closed".into()))
    }

    /// Fixed, private image stream. A dropped/failed initialization ends only this session.
    pub(crate) async fn initialize_with_images(&mut self, entries: Value, workspace_map: Value,
        verification: Option<Value>, generation: Option<GenerationProfile>,
        image_transfers: &[ImageTransfer], prompt_image_ids: &[String]) -> Result<(), SidecarError> {
        if image_transfers.is_empty() && prompt_image_ids.is_empty() {
            return self.initialize_with_generation(entries, workspace_map, verification, generation).await;
        }
        let (frame, decoded) = image_session_frame(entries, workspace_map, verification, generation,
            image_transfers, prompt_image_ids)?;
        let mut guard = ImageInitializationGuard { core: &self.core, child: &mut self.child, completed: false };
        guard.core.send_confirmed(frame).await?;
        for (image, bytes) in image_transfers.iter().zip(decoded.iter()) {
            for (index, chunk) in bytes.chunks(IMAGE_CHUNK_BYTES).enumerate() {
                guard.core.send_confirmed(json!({"type":"image_chunk","imageId":image.id,"index":index,"data":BASE64.encode(chunk)}).to_string()).await?;
            }
            guard.core.send_confirmed(json!({"type":"image_end","imageId":image.id}).to_string()).await?;
        }
        guard.completed = true;
        Ok(())
    }
    /// Spawn the sidecar process and start the protocol loop.
    ///
    /// stderr is drained into a bounded tail for diagnostics; it is never
    /// parsed as protocol (stdout carries all frames).
    pub async fn spawn(spec: SidecarSpec, hooks: SidecarHooks) -> Result<Self, SidecarError> {
        Self::spawn_with_limits(spec, hooks, SidecarLimits::default()).await
    }

    pub async fn spawn_with_limits(
        spec: SidecarSpec,
        hooks: SidecarHooks,
        limits: SidecarLimits,
    ) -> Result<Self, SidecarError> {
        let mut command = crate::local_cli::quiet_command(&spec.program);
        if let Some(cache) = node_compile_cache(&spec) { command.env("NODE_COMPILE_CACHE", cache); }
        let mut child = command
            .args(&spec.args)
            .envs(spec.env.iter().cloned())
            .current_dir(&spec.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| SidecarError::Spawn(error.to_string()))?;
        let (stdin, stdout, stderr) =
            match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
                (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
                _ => {
                    let _ = child.kill().await;
                    return Err(SidecarError::Spawn("stdio pipes unavailable".into()));
                }
            };
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        let stderr_task = tokio::spawn(drain_stderr(
            stderr,
            stderr_tail.clone(),
            hooks.on_stderr.clone(),
        ));
        let core = attach(stdout, stdin, hooks, limits);
        Ok(Self {
            core,
            child: Some(child),
            stderr_tail,
            stderr_task: Some(stderr_task),
        })
    }

    /// The `hello` handshake, once received.
    pub fn hello(&self) -> Option<HelloInfo> {
        self.core.hello()
    }

    /// Advertised tool descriptors from `hello` (name/description/schema).
    pub fn tools(&self) -> Option<Vec<SidecarTool>> {
        self.hello().map(|hello| hello.tools)
    }

    /// Names the sidecar activated, from `hello.activeTools`.
    pub fn active_tools(&self) -> Option<Vec<String>> {
        self.hello().map(|hello| hello.active_tools)
    }

    /// Bounded tail of the sidecar's stderr log for diagnostics.
    pub fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The live stderr tail buffer. `wait()` consumes the session, so callers
    /// that need mid-run or post-exit diagnostics clone this handle first;
    /// the drain task keeps appending until the child dies.
    pub fn stderr_handle(&self) -> Arc<Mutex<VecDeque<String>>> {
        self.stderr_tail.clone()
    }

    /// Send a `tool_partial` progress frame for an in-flight call.
    pub async fn send_partial(
        &self,
        id: &str,
        content: Value,
        details: Value,
    ) -> Result<(), SidecarError> {
        self.core.send_partial(id, content, details).await
    }

    /// Wait for the session to finish: `agent_done` + EOF, or a failure.
    /// On failure the child is killed; on success it gets a short grace to
    /// exit on its own before being reaped.
    pub async fn wait(mut self) -> Result<SidecarOutcome, SidecarError> {
        let result = (&mut self.core.join).await;
        let mut child = self.child.take().expect("child present");
        let exit_code = if result.is_ok() {
            match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
                Ok(Ok(status)) => status.code(),
                _ => {
                    let _ = child.kill().await;
                    None
                }
            }
        } else {
            let _ = child.kill().await;
            None
        };
        match result {
            Ok(Ok(ok)) => Ok(SidecarOutcome { ok, exit_code }),
            Ok(Err(error)) => Err(error),
            Err(error) => Err(SidecarError::Internal(format!("transport task: {error}"))),
        }
    }
}

impl Drop for SidecarSession {
    fn drop(&mut self) {
        stop_steering(&self.core.shared);
        self.core.join.abort();
        if let Some(task) = &self.stderr_task {
            task.abort();
        }
        // The child is killed via kill_on_drop when `child` drops.
    }
}

async fn drain_stderr(
    stderr: impl AsyncRead + Unpin,
    sink: Arc<Mutex<VecDeque<String>>>,
    on_line: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        {
            let mut tail = sink.lock().unwrap();
            if tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
        if let Some(hook) = &on_line {
            hook();
        }
    }
}

// ---------------------------------------------------------------------------
// Tests: the whole protocol runs over an in-memory duplex, no child process.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{DuplexStream, Lines, ReadHalf, WriteHalf};

    #[test]
    fn compile_cache_only_for_node_and_never_overrides_an_explicit_choice() {
        let spec = |program: &str, env: Vec<(String, String)>| SidecarSpec { program: program.into(), args: vec![], workspace: PathBuf::new(), env };
        assert!(node_compile_cache(&spec("python", vec![])).is_none());
        assert!(node_compile_cache(&spec("node", vec![("NODE_COMPILE_CACHE".into(), "x".into())])).is_none());
        if std::env::var_os("NODE_COMPILE_CACHE").is_none() {
            for program in ["node", "C:/tools/node.exe"] {
                assert!(node_compile_cache(&spec(program, vec![])).unwrap().ends_with("jkamma-hub/pi-compile-cache"));
            }
        }
    }

    const IMAGE_ID: &str = "00000000-0000-4000-8000-000000000001";
    fn image_fixture(id: &str, size: usize) -> ImageTransfer {
        let bytes = vec![42u8; size];
        ImageTransfer { id:id.into(), mime_type:"image/png".into(), size_bytes:size,
            sha256:format!("{:x}", Sha256::digest(&bytes)), data_base64:BASE64.encode(bytes) }
    }
    fn image_session(core: TransportCore) -> SidecarSession {
        SidecarSession { core, child:None, stderr_tail:Arc::new(Mutex::new(VecDeque::new())), stderr_task:None }
    }

    #[test]
    fn image_initialization_metadata_is_closed_and_empty_shape_stays_legacy() {
        let old=session_frame(json!([]),Value::Null,None,None).unwrap();
        let (empty,raw)=image_session_frame(json!([]),Value::Null,None,None,&[],&[]).unwrap();
        assert_eq!(old,empty);assert!(raw.is_empty());
        let images=[image_fixture(IMAGE_ID,3)];
        let (frame,raw)=image_session_frame(json!([]),Value::Null,None,None,&images,&[IMAGE_ID.into()]).unwrap();
        assert_eq!(raw,vec![vec![42;3]]);
        let frame:Value=serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["imageRefs"],json!([{"id":IMAGE_ID,"mimeType":"image/png","sizeBytes":3,"sha256":images[0].sha256}]));
        assert_eq!(frame["promptImageIds"],json!([IMAGE_ID]));
        assert!(frame["imageRefs"][0].get("data").is_none());
        assert!(image_session_frame(json!([]),Value::Null,None,None,&images,&[]).is_ok());
    }

    #[test]
    fn image_inputs_frame_is_closed_bounded_unique_uuid4_and_preserves_order() {
        let other="00000000-0000-4000-8000-000000000002";
        let frame:SidecarFrame=serde_json::from_value(json!({"type":"image_inputs","promptImageIds":[IMAGE_ID],"reattachedImageIds":[other,IMAGE_ID]})).unwrap();
        match frame {SidecarFrame::ImageInputs{input}=>{assert_eq!(input.prompt_image_ids,vec![IMAGE_ID]);assert_eq!(input.reattached_image_ids,vec![other,IMAGE_ID]);},_=>panic!("wrong frame")}
        for (index,value) in [
            json!({"type":"image_inputs","promptImageIds":[],"reattachedImageIds":[],"data":"forbidden"}),
            json!({"type":"image_inputs","promptImageIds":[],"reattachedImageIds":[],"unknown":null}),
            json!({"type":"image_inputs","promptImageIds":[],"reattachedImageIds":null}),
            json!({"type":"image_inputs","promptImageIds":[IMAGE_ID,other],"reattachedImageIds":[]}),
            json!({"type":"image_inputs","promptImageIds":[],"reattachedImageIds":[IMAGE_ID,IMAGE_ID]}),
            json!({"type":"image_inputs","promptImageIds":[format!("{IMAGE_ID}\n")],"reattachedImageIds":[]}),
            json!({"type":"image_inputs","promptImageIds":[],"reattachedImageIds":[IMAGE_ID,other,"bad"]}),
            json!({"type":"image_inputs","promptImageIds":[],"reattachedImageIds":[IMAGE_ID,other,IMAGE_ID,other,IMAGE_ID]}),
            json!({"type":"image_inputs","reattachedImageIds":[]}),
        ].into_iter().enumerate() {assert!(serde_json::from_value::<SidecarFrame>(value).is_err(),"invalid receipt case {index}");}
        assert!(serde_json::from_str::<SidecarFrame>(r#"{"type":"image_inputs","promptImageIds":[],"promptImageIds":[],"reattachedImageIds":[]}"#).is_err());
        assert!(serde_json::from_value::<SidecarFrame>(json!({"type":"partial","text":"old"})).is_ok());
    }

    #[tokio::test]
    async fn image_inputs_frame_notifies_existing_observer_without_bodies() {
        let seen=Arc::new(Mutex::new(Vec::new()));let captured=seen.clone();
        let hooks=SidecarHooks::new(text_executor("unused")).with_observer(Arc::new(move|event|if let SessionEvent::AgentEvent(value)=event {captured.lock().unwrap().push(value);}));
        let (core,_output,mut input)=rig(hooks,fast_limits());
        send_frame(&mut input,json!({"type":"image_inputs","promptImageIds":[IMAGE_ID],"reattachedImageIds":[]})).await;
        wait_until(||!seen.lock().unwrap().is_empty()).await;
        assert_eq!(seen.lock().unwrap()[0],json!({"type":"image_inputs","promptImageIds":[IMAGE_ID],"reattachedImageIds":[]}));
        core.join.abort();
    }

    #[test]
    fn image_initialization_rejects_corrupt_digest_noncanonical_data_and_metadata() {
        for kind in ["id","mime","zero","over","size","sha","sha_case","data","padding","trailing"] {
            let mut image=image_fixture(IMAGE_ID,1);
            match kind {
                "id"=>image.id.push('\n'),"mime"=>image.mime_type="image/webp".into(),
                "zero"=>image.size_bytes=0,"over"=>image.size_bytes=MAX_IMAGE_BYTES+1,
                "size"=>image.size_bytes=2,"sha"=>image.sha256="0".repeat(64),
                "sha_case"=>image.sha256=image.sha256.to_uppercase(),"data"=>image.data_base64="?===".into(),
                "padding"=>image.data_base64="Kg".into(),"trailing"=>image.data_base64="Kh==".into(),_=>unreachable!(),
            }
            assert!(image_session_frame(Value::Null,Value::Null,None,None,&[image],&[]).is_err(),"{kind}");
        }
        for id in ["00000000-0000-3000-8000-000000000001","00000000-0000-4000-7000-000000000001","00000000-0000-4000-8000-00000000000A","bad"] {
            assert!(!image_id(id));
        }
    }

    #[test]
    fn image_initialization_enforces_four_unique_refs_one_prompt_and_frame_limit() {
        let ids=(1..=5).map(|index|format!("00000000-0000-4000-8000-{index:012x}")).collect::<Vec<_>>();
        let images=ids.iter().map(|id|image_fixture(id,1)).collect::<Vec<_>>();
        assert!(image_session_frame(Value::Null,Value::Null,None,None,&images[..4],&[ids[3].clone()]).is_ok());
        assert!(image_session_frame(Value::Null,Value::Null,None,None,&images,&[]).is_err());
        assert!(image_session_frame(Value::Null,Value::Null,None,None,&images[..4],&ids[..2]).is_err());
        assert!(image_session_frame(Value::Null,Value::Null,None,None,&images[..4],&[ids[4].clone()]).is_err());
        assert!(image_session_frame(Value::Null,Value::Null,None,None,&[],&[ids[0].clone()]).is_err());
        let duplicate=[image_fixture(IMAGE_ID,1),image_fixture(IMAGE_ID,1)];
        assert!(image_session_frame(Value::Null,Value::Null,None,None,&duplicate,&[]).is_err());
        assert!(image_session_frame(json!("x".repeat(MAX_FRAME_BYTES)),Value::Null,None,None,&images[..1],&[]).is_err());
    }

    #[test]
    fn image_initialization_accepts_raw_ten_mib_without_large_wire_frame() {
        let images=[image_fixture(IMAGE_ID,MAX_IMAGE_BYTES)];
        let (frame,decoded)=image_session_frame(Value::Null,Value::Null,None,None,&images,&[]).unwrap();
        assert!(frame.len()<MAX_FRAME_BYTES);assert_eq!(decoded[0].len(),MAX_IMAGE_BYTES);
        assert_eq!(MAX_IMAGE_REFS*MAX_IMAGE_BYTES,40*1024*1024);
        assert_eq!(decoded[0].chunks(IMAGE_CHUNK_BYTES).count(),54);
    }

    #[tokio::test]
    async fn image_initialization_wire_chunks_are_ordered_bounded_and_exact() {
        for size in [1,IMAGE_CHUNK_BYTES-1,IMAGE_CHUNK_BYTES,IMAGE_CHUNK_BYTES+1,2*IMAGE_CHUNK_BYTES+1] {
            let (core,mut output,_input)=rig(SidecarHooks::new(text_executor("unused")),fast_limits());
            let task=tokio::spawn(async move {let mut session=image_session(core);let images=[image_fixture(IMAGE_ID,size)];
                let result=session.initialize_with_images(json!([]),Value::Null,None,None,&images,&[IMAGE_ID.into()]).await;(session,result)});
            let header=recv_frame(&mut output).await;assert_eq!(header["type"],"session");assert_eq!(header["imageRefs"][0]["sizeBytes"],size);
            let mut restored=Vec::new();
            for index in 0..size.div_ceil(IMAGE_CHUNK_BYTES) {
                let frame=recv_frame(&mut output).await;assert_eq!(frame["type"],"image_chunk");assert_eq!(frame["imageId"],IMAGE_ID);assert_eq!(frame["index"],index);
                let bytes=BASE64.decode(frame["data"].as_str().unwrap()).unwrap();
                assert_eq!(bytes.len(),(size-index*IMAGE_CHUNK_BYTES).min(IMAGE_CHUNK_BYTES));
                assert!(frame.to_string().len()<MAX_FRAME_BYTES);restored.extend(bytes);
            }
            assert_eq!(recv_frame(&mut output).await,json!({"type":"image_end","imageId":IMAGE_ID}));
            assert_eq!(restored,vec![42;size]);let (session,result)=task.await.unwrap();assert!(result.is_ok());drop(session);
        }
    }

    #[tokio::test]
    async fn image_initialization_waits_for_actual_write_backpressure() {
        let (core,mut output,_input)=rig(SidecarHooks::new(text_executor("unused")),fast_limits());
        let mut task=tokio::spawn(async move {let mut session=image_session(core);let images=[image_fixture(IMAGE_ID,IMAGE_CHUNK_BYTES)];
            let result=session.initialize_with_images(json!([]),Value::Null,None,None,&images,&[]).await;(session,result)});
        assert_eq!(recv_frame(&mut output).await["type"],"session");
        assert!(tokio::time::timeout(Duration::from_millis(20),&mut task).await.is_err());
        assert_eq!(recv_frame(&mut output).await["type"],"image_chunk");
        assert_eq!(recv_frame(&mut output).await["type"],"image_end");
        let (session,result)=task.await.unwrap();assert!(result.is_ok());drop(session);
    }

    struct FailingImageWriter { writes_before_failure:usize, flush:bool }
    impl AsyncWrite for FailingImageWriter {
        fn poll_write(mut self:Pin<&mut Self>,_:&mut std::task::Context<'_>,bytes:&[u8])->std::task::Poll<std::io::Result<usize>> {
            if self.flush { return std::task::Poll::Ready(Ok(bytes.len())); }
            if self.writes_before_failure>0 {self.writes_before_failure-=1;return std::task::Poll::Ready(Ok(bytes.len()));}
            std::task::Poll::Ready(Err(std::io::Error::other("synthetic writer failed")))
        }
        fn poll_flush(self:Pin<&mut Self>,_:&mut std::task::Context<'_>)->std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(if self.flush {Err(std::io::Error::other("synthetic flush failed"))}else{Ok(())})
        }
        fn poll_shutdown(self:Pin<&mut Self>,_:&mut std::task::Context<'_>)->std::task::Poll<std::io::Result<()>> {std::task::Poll::Ready(Ok(()))}
    }
    #[tokio::test]
    async fn image_initialization_failed_write_returns_error_and_ends_owned_transport() {
        for (writes_before_failure,flush) in [(0,false),(1,false),(0,true)] {
            let (reader,_peer)=tokio::io::duplex(1024);
            let core=attach(reader,FailingImageWriter{writes_before_failure,flush},SidecarHooks::new(text_executor("unused")),fast_limits());
            let mut session=image_session(core);let images=[image_fixture(IMAGE_ID,1)];
            assert!(matches!(session.initialize_with_images(json!([]),Value::Null,None,None,&images,&[]).await,Err(SidecarError::Transport(_))));
            assert!(session.core.shared.ending.load(Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn image_initialization_future_abort_cleans_only_its_session() {
        let (core,mut output,_input)=rig(SidecarHooks::new(text_executor("unused")),fast_limits());
        let (other_core,mut other_output,_other_input)=rig(SidecarHooks::new(text_executor("unused")),fast_limits());
        let mut session=image_session(core);let images=[image_fixture(IMAGE_ID,IMAGE_CHUNK_BYTES)];
        assert!(tokio::time::timeout(Duration::from_millis(20),session.initialize_with_images(json!([]),Value::Null,None,None,&images,&[])).await.is_err());
        assert!(session.core.shared.ending.load(Ordering::SeqCst));
        assert_eq!(recv_frame(&mut output).await["type"],"session");
        let other=image_session(other_core);other.initialize(json!([]),Value::Null,None).await.unwrap();
        assert_eq!(recv_frame(&mut other_output).await["type"],"session");assert!(!other.core.shared.ending.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn change_observer_executor_records_writes_and_edits_without_changing_answers() {
        let (_guard, root) = seeded_workspace();
        let seen = Arc::new(Mutex::new(Vec::<agent_tools::Change>::new()));
        let captured = seen.clone();
        let executor = hub_executor_with_changes(root.clone(), true, HubToolCaps::default(), None, Arc::new(move |change| captured.lock().unwrap().push(change)));
        executor.execute("hub_read".into(), json!({"path":"a.txt"})).await.unwrap();
        assert!(seen.lock().unwrap().is_empty());
        for (path, content) in [("new.txt", ""), ("a.txt", "first"), ("a.txt", "second")] {
            let answer = executor.execute("hub_write".into(), json!({"path":path,"content":content})).await.unwrap();
            assert_eq!(answer.details, json!({"path":path,"sha256":agent_tools::digest(content.as_bytes())}));
            assert_eq!(answer.content, json!([{"type":"text","text":answer.details.to_string()}]));
        }
        executor.execute("hub_edit".into(), json!({"path":"a.txt","content":json!({"oldText":"second","newText":"edited"}).to_string()})).await.unwrap();
        let changes = seen.lock().unwrap();
        assert_eq!(changes.len(), 4);
        assert!(changes[0].previous_sha256.is_none());
        assert!(changes[0].before.is_empty() && changes[0].after.is_empty());
        assert_eq!(changes[1].before, "hello pi");
        assert_eq!(changes[2].before, "first");
        assert_eq!(changes[3].before, "second");
        assert_eq!(changes[3].after, "edited");
    }

    #[tokio::test]
    async fn change_observer_executor_keeps_denial_stale_and_failure_paths_silent() {
        let (_guard, root) = seeded_workspace();
        let seen = Arc::new(Mutex::new(Vec::<agent_tools::Change>::new()));
        let captured = seen.clone();
        let observer: Arc<dyn Fn(agent_tools::Change) + Send + Sync> = Arc::new(move |change| captured.lock().unwrap().push(change));
        let denied = hub_executor_with_changes(root.clone(), false, HubToolCaps::default(), None, observer.clone());
        assert_eq!(denied.execute("hub_write".into(), json!({"path":"new.txt","content":"x"})).await.unwrap_err(), "write_not_permitted");
        let (approver, _) = recording_approver(false);
        let denied = hub_executor_with_changes(root.clone(), false, HubToolCaps::default(), Some(approver), observer.clone());
        assert_eq!(denied.execute("hub_write".into(), json!({"path":"new.txt","content":"x"})).await.unwrap_err(), "approval_denied");
        let executor = hub_executor_with_changes(root.clone(), true, HubToolCaps::default(), None, observer);
        executor.execute("hub_read".into(), json!({"path":"a.txt"})).await.unwrap();
        std::fs::write(root.join("a.txt"), "external").unwrap();
        assert_eq!(executor.execute("hub_write".into(), json!({"path":"a.txt","content":"x"})).await.unwrap_err(), "file_changed_since_read");
        assert!(executor.execute("hub_write".into(), json!({"path":"../escape.txt","content":"x"})).await.is_err());
        std::fs::write(root.join(".hub-local-runner"), "blocked archive").unwrap();
        assert!(executor.execute("hub_write".into(), json!({"path":"new.txt","content":"x"})).await.is_err());
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "external");
        assert!(!root.join("new.txt").exists());
    }

    #[tokio::test]
    async fn change_observer_executor_scopes_observations_to_its_executor() {
        let (_guard, root) = seeded_workspace();
        let logs: Vec<_> = (0..2).map(|_| Arc::new(Mutex::new(Vec::<agent_tools::Change>::new()))).collect();
        let executors: Vec<_> = logs.iter().map(|log| {
            let log = log.clone();
            hub_executor_with_changes(root.clone(), true, HubToolCaps::default(), None, Arc::new(move |change| log.lock().unwrap().push(change)))
        }).collect();
        executors[0].execute("hub_write".into(), json!({"path":"new.txt","content":"first"})).await.unwrap();
        assert_eq!(executors[1].execute("hub_write".into(), json!({"path":"new.txt","content":"second"})).await.unwrap_err(), "read_before_write_required");
        executors[1].execute("hub_read".into(), json!({"path":"new.txt"})).await.unwrap();
        executors[1].execute("hub_write".into(), json!({"path":"new.txt","content":"second"})).await.unwrap();
        assert_eq!(logs[0].lock().unwrap().len(), 1);
        assert_eq!(logs[1].lock().unwrap().len(), 1);
        assert_eq!(logs[0].lock().unwrap()[0].after, "first");
        assert_eq!(logs[1].lock().unwrap()[0].before, "first");
        assert_eq!(executors[0].execute("hub_write".into(), json!({"path":"new.txt","content":"third"})).await.unwrap_err(), "file_changed_since_read");
        let legacy = hub_executor(root.clone(), true, HubToolCaps::default(), None);
        legacy.execute("hub_write".into(), json!({"path":"legacy.txt","content":"legacy"})).await.unwrap();
        assert_eq!(logs[0].lock().unwrap().len(), 1);
        assert_eq!(logs[1].lock().unwrap().len(), 1);
    }

    type SidecarOut = Lines<BufReader<ReadHalf<DuplexStream>>>;
    type SidecarIn = WriteHalf<DuplexStream>;

    fn fast_limits() -> SidecarLimits {
        SidecarLimits {
            session: Duration::from_secs(5),
            tool_call: Duration::from_millis(200),
            drain: Duration::from_millis(100),
        }
    }

    fn rig(hooks: SidecarHooks, limits: SidecarLimits) -> (TransportCore, SidecarOut, SidecarIn) {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (rd, wr) = tokio::io::split(ours);
        let (side_rd, side_wr) = tokio::io::split(theirs);
        (
            attach(rd, wr, hooks, limits),
            BufReader::new(side_rd).lines(),
            side_wr,
        )
    }

    fn text_executor(body: &'static str) -> Arc<dyn ToolExecutor> {
        Arc::new(move |_name: String, _args: Value| async move { Ok(ToolAnswer::text(body)) })
    }

    async fn send_frame(wr: &mut SidecarIn, frame: Value) {
        wr.write_all(serde_json::to_string(&frame).unwrap().as_bytes())
            .await
            .unwrap();
        wr.write_all(b"\n").await.unwrap();
    }

    async fn recv_frame(lines: &mut SidecarOut) -> Value {
        let line = lines.next_line().await.unwrap().expect("expected a frame");
        serde_json::from_str(&line).expect("frame is valid json")
    }

    async fn wait_until(flag: impl Fn() -> bool) {
        for _ in 0..200 {
            if flag() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not met in time");
    }

    #[tokio::test]
    async fn hello_is_stored_and_exposed() {
        let (core, lines, mut wr) = rig(SidecarHooks::new(text_executor("unused")), fast_limits());
        send_frame(
            &mut wr,
            json!({
                "type": "hello",
                "proto": 1,
                "activeTools": ["hub_read"],
                "tools": [{
                    "name": "hub_read",
                    "description": "Read a UTF-8 text file.",
                    "parameters": {"type": "object", "required": ["path"]}
                }]
            }),
        )
        .await;
        wait_until(|| core.hello().is_some()).await;
        let hello = core.hello().unwrap();
        assert_eq!(hello.proto, 1);
        assert_eq!(hello.active_tools, vec!["hub_read".to_string()]);
        assert_eq!(hello.tools.len(), 1);
        assert_eq!(hello.tools[0].name, "hub_read");
        assert_eq!(hello.tools[0].parameters["required"], json!(["path"]));
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
    }

    /// Newer bundles report the resolved spec in `hello` and, on a
    /// resolution failure, the registry's alternatives; bundles built before
    /// the fields existed must still parse with them absent.
    #[tokio::test]
    async fn hello_carries_the_resolved_model_and_stays_backward_compatible() {
        let (core, lines, mut wr) = rig(SidecarHooks::new(text_executor("unused")), fast_limits());
        send_frame(
            &mut wr,
            json!({
                "type": "hello",
                "proto": 1,
                "activeTools": ["hub_read"],
                "tools": [],
                "model": "ollama/qwen2.5:3b"
            }),
        )
        .await;
        wait_until(|| core.hello().is_some()).await;
        let hello = core.hello().unwrap();
        assert_eq!(hello.model.as_deref(), Some("ollama/qwen2.5:3b"));
        assert_eq!(hello.available, None);
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());

        // Resolution failure: model null, `available` lists the offer.
        let legacy: SidecarFrame =
            serde_json::from_str(r#"{"type":"hello","proto":1,"activeTools":[],"tools":[]}"#)
                .expect("a hello without the new fields still parses");
        let SidecarFrame::Hello {
            model, available, ..
        } = legacy
        else {
            panic!("hello frame");
        };
        assert_eq!(model, None);
        assert_eq!(available, None);
        let failed: SidecarFrame = serde_json::from_str(
            r#"{"type":"hello","proto":1,"model":null,"available":["ollama/qwen2.5:3b","openai/gpt-5"]}"#,
        )
        .expect("failure hello parses");
        let SidecarFrame::Hello {
            model, available, ..
        } = failed
        else {
            panic!("hello frame");
        };
        assert_eq!(model, None);
        assert_eq!(
            available,
            Some(vec![
                "ollama/qwen2.5:3b".to_string(),
                "openai/gpt-5".to_string()
            ])
        );
    }

    #[tokio::test]
    async fn tool_call_round_trip_returns_tool_result() {
        let executor = Arc::new(|name: String, args: Value| async move {
            assert_eq!(name, "hub_read");
            assert_eq!(args["path"], "secret.txt");
            Ok(ToolAnswer {
                content: json!([{"type": "text", "text": "file body"}]),
                details: json!({"bytes": 9}),
                usage: Some(json!({"input": 1, "output": 0})),
                terminate: Some(false),
            })
        });
        let (core, mut lines, mut wr) = rig(SidecarHooks::new(executor), fast_limits());
        send_frame(
            &mut wr,
            json!({"type": "tool_call", "id": "tc_1", "name": "hub_read", "args": {"path": "secret.txt"}}),
        )
        .await;
        let frame = recv_frame(&mut lines).await;
        assert_eq!(frame["type"], "tool_result");
        assert_eq!(frame["id"], "tc_1");
        assert_eq!(frame["content"][0]["text"], "file body");
        assert_eq!(frame["details"]["bytes"], 9);
        assert_eq!(frame["usage"]["input"], 1);
        assert_eq!(frame["terminate"], false);
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
    }

    #[tokio::test]
    async fn executor_error_becomes_tool_error() {
        let executor = Arc::new(|_name: String, _args: Value| async {
            Err("permission denied: path escapes workspace".to_string())
        });
        let (core, mut lines, mut wr) = rig(SidecarHooks::new(executor), fast_limits());
        send_frame(
            &mut wr,
            json!({"type": "tool_call", "id": "tc_2", "name": "hub_read", "args": {"path": "../x"}}),
        )
        .await;
        let frame = recv_frame(&mut lines).await;
        assert_eq!(frame["type"], "tool_error");
        assert_eq!(frame["id"], "tc_2");
        assert_eq!(
            frame["message"],
            "permission denied: path escapes workspace"
        );
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
    }

    #[tokio::test]
    async fn executor_panic_becomes_tool_error() {
        let executor = Arc::new(|_name: String, _args: Value| async { panic!("executor blew up") });
        let (core, mut lines, mut wr) = rig(SidecarHooks::new(executor), fast_limits());
        send_frame(
            &mut wr,
            json!({"type": "tool_call", "id": "tc_3", "name": "hub_read", "args": {}}),
        )
        .await;
        let frame = recv_frame(&mut lines).await;
        assert_eq!(frame["type"], "tool_error");
        assert_eq!(frame["id"], "tc_3");
        assert_eq!(frame["message"], "executor panicked");
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
    }

    #[tokio::test]
    async fn cancel_aborts_the_in_flight_executor_call() {
        let started = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        let (mark_started, mark_dropped) = (started.clone(), dropped.clone());
        let executor = move |_name: String, _args: Value| {
            let (mark_started, mark_dropped) = (mark_started.clone(), mark_dropped.clone());
            async move {
                struct AbortFlag(Arc<AtomicBool>);
                impl Drop for AbortFlag {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                mark_started.store(true, Ordering::SeqCst);
                let _flag = AbortFlag(mark_dropped);
                std::future::pending::<Result<ToolAnswer, String>>().await
            }
        };
        let (core, mut lines, mut wr) = rig(SidecarHooks::new(Arc::new(executor)), fast_limits());
        send_frame(
            &mut wr,
            json!({"type": "tool_call", "id": "tc_4", "name": "hub_read", "args": {"path": "slow.txt"}}),
        )
        .await;
        // Wait until the executor future is actually live; aborting a task
        // that was never polled would drop nothing.
        let check = started.clone();
        wait_until(move || check.load(Ordering::SeqCst)).await;
        send_frame(&mut wr, json!({"type": "cancel", "id": "tc_4"})).await;
        let frame = recv_frame(&mut lines).await;
        assert_eq!(frame["type"], "tool_error");
        assert_eq!(frame["id"], "tc_4");
        assert_eq!(frame["message"], "cancelled");
        // The executor future must actually be dropped, not merely answered.
        let check = dropped.clone();
        wait_until(move || check.load(Ordering::SeqCst)).await;
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
    }

    /// SWE-bench django-11400 stalled on three parallel reads. Hub must answer
    /// every id even while the sidecar sends large frames without reading
    /// (a single-threaded peer), and each read result stays bounded.
    #[tokio::test]
    async fn parallel_large_reads_all_answer_while_the_peer_is_not_reading() {
        let (_guard, root) = seeded_workspace();
        for n in 0..3 {
            let body: String = (0..3000).map(|line| format!("file {n} line {line} {}\n", "y".repeat(30))).collect();
            std::fs::write(root.join(format!("big{n}.py")), body).unwrap();
        }
        let executor = hub_executor(root.clone(), true, HubToolCaps::default(), None);
        let (core, mut lines, mut wr) = rig(SidecarHooks::new(executor), SidecarLimits {
            tool_call: Duration::from_secs(5),
            ..fast_limits()
        });
        for n in 0..3 {
            send_frame(&mut wr, json!({"type":"tool_call","id":format!("tc_{n}"),"name":"hub_read","args":{"path":format!("big{n}.py")}})).await;
        }
        // Large inbound frames while Hub's answers are still unread: the reader must not
        // wait on the writer (the duplex buffer is 64 KiB, three answers exceed it).
        let noise = "z".repeat(200_000);
        for _ in 0..3 {
            send_frame(&mut wr, json!({"type":"event","event":{"type":"fixture_noise","text":noise}})).await;
        }
        let mut seen = std::collections::BTreeSet::new();
        while seen.len() < 3 {
            let frame = tokio::time::timeout(Duration::from_secs(5), recv_frame(&mut lines)).await.expect("every parallel read is answered");
            assert_eq!(frame["type"], "tool_result", "{frame}");
            let text = frame["content"][0]["text"].as_str().unwrap();
            assert!(text.len() <= agent_tools::MAX_RESULT_BYTES);
            assert_eq!(frame["details"]["partial"], true);
            assert!(seen.insert(frame["id"].as_str().unwrap().to_owned()));
        }
        // The page reads observed the whole files, so a large-file edit works.
        send_frame(&mut wr, json!({"type":"tool_call","id":"tc_edit","name":"hub_edit","args":{"path":"big2.py",
            "content":json!({"oldText":"file 2 line 2999 ","newText":"file 2 line 2999 edited "}).to_string()}})).await;
        let edited = recv_frame(&mut lines).await;
        assert_eq!((edited["type"].as_str(), edited["id"].as_str()), (Some("tool_result"), Some("tc_edit")), "{edited}");
        assert!(std::fs::read_to_string(root.join("big2.py")).unwrap().contains("line 2999 edited y"));
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
    }

    #[tokio::test]
    async fn tool_call_deadline_answers_tool_error() {
        let executor = Arc::new(|_name: String, _args: Value| async {
            std::future::pending::<Result<ToolAnswer, String>>().await
        });
        let limits = SidecarLimits {
            tool_call: Duration::from_millis(40),
            ..fast_limits()
        };
        let (core, mut lines, mut wr) = rig(SidecarHooks::new(executor), limits);
        send_frame(
            &mut wr,
            json!({"type": "tool_call", "id": "tc_5", "name": "hub_read", "args": {}}),
        )
        .await;
        let frame = recv_frame(&mut lines).await;
        assert_eq!(frame["type"], "tool_error");
        assert_eq!(frame["id"], "tc_5");
        assert!(frame["message"].as_str().unwrap().contains("timed out"));
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
    }

    #[tokio::test]
    async fn send_partial_writes_a_tool_partial_frame() {
        let (core, mut lines, _wr) = rig(SidecarHooks::new(text_executor("unused")), fast_limits());
        core.send_partial(
            "tc_6",
            json!([{"type": "text", "text": "hub: reading…"}]),
            json!({}),
        )
        .await
        .unwrap();
        let frame = recv_frame(&mut lines).await;
        assert_eq!(frame["type"], "tool_partial");
        assert_eq!(frame["id"], "tc_6");
        assert_eq!(frame["content"][0]["text"], "hub: reading…");
    }

    #[tokio::test]
    async fn malformed_json_fails_the_session() {
        let (core, _lines, mut wr) = rig(SidecarHooks::new(text_executor("unused")), fast_limits());
        wr.write_all(b"this is not json\n").await.unwrap();
        let error = core.wait().await.unwrap_err();
        assert!(matches!(error, SidecarError::Protocol(_)), "got {error}");
    }

    #[tokio::test]
    async fn unknown_frame_type_fails_the_session() {
        let (core, _lines, mut wr) = rig(SidecarHooks::new(text_executor("unused")), fast_limits());
        send_frame(&mut wr, json!({"type": "mystery"})).await;
        let error = core.wait().await.unwrap_err();
        assert!(matches!(error, SidecarError::Protocol(_)), "got {error}");
    }

    #[tokio::test]
    async fn eof_without_agent_done_is_an_interruption() {
        let (core, lines, wr) = rig(SidecarHooks::new(text_executor("unused")), fast_limits());
        // Both halves of the peer stream must drop before our reader sees EOF.
        drop(lines);
        drop(wr);
        let error = core.wait().await.unwrap_err();
        assert!(matches!(error, SidecarError::Interrupted), "got {error}");
    }

    /// A writer that fails every write; injects the real-process case where
    /// the child's stdin pipe is broken mid-session.
    struct BrokenWriter;

    impl AsyncWrite for BrokenWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "injected",
            )))
        }
        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "injected",
            )))
        }
        fn poll_shutdown(
            self: Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn writer_failure_fails_the_session() {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (rd, _our_wr) = tokio::io::split(ours);
        let (side_rd, mut side_wr) = tokio::io::split(theirs);
        let core = attach(
            rd,
            BrokenWriter,
            SidecarHooks::new(text_executor("body")),
            fast_limits(),
        );
        let _lines = BufReader::new(side_rd).lines();
        send_frame(
            &mut side_wr,
            json!({"type": "tool_call", "id": "tc_8", "name": "hub_read", "args": {}}),
        )
        .await;
        let error = core.wait().await.unwrap_err();
        assert!(matches!(error, SidecarError::Transport(_)), "got {error}");
    }

    #[tokio::test]
    async fn session_deadline_fails_when_sidecar_goes_silent() {
        let limits = SidecarLimits {
            session: Duration::from_millis(40),
            ..fast_limits()
        };
        let (core, _lines, _wr) = rig(SidecarHooks::new(text_executor("unused")), limits);
        let error = core.wait().await.unwrap_err();
        assert!(matches!(error, SidecarError::Timeout), "got {error}");
    }

    #[tokio::test]
    async fn agent_done_without_eof_waits_then_reports() {
        let limits = SidecarLimits {
            drain: Duration::from_millis(40),
            ..fast_limits()
        };
        let (core, _lines, mut wr) = rig(SidecarHooks::new(text_executor("unused")), limits);
        send_frame(&mut wr, json!({"type": "agent_done", "ok": false})).await;
        // No EOF: the drain grace expires and we still learn ok=false.
        assert!(!core.wait().await.unwrap());
    }

    #[tokio::test]
    async fn frames_are_mirrored_to_the_observer() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let hooks =
            SidecarHooks::new(text_executor("unused")).with_observer(Arc::new(move |event| {
                let tag = match event {
                    SessionEvent::Hello {
                        proto,
                        active_tools,
                        ..
                    } => {
                        format!("hello:{proto}:{}", active_tools.len())
                    }
                    SessionEvent::AgentEvent(value) => {
                        format!("agent:{}", value["type"].as_str().unwrap_or(""))
                    }
                    SessionEvent::PartialOutput { text } => format!("partial:{text}"),
                    SessionEvent::ToolCallStarted { id, name, detail } => {
                        format!("start:{id}:{name}:{}", detail.as_deref().unwrap_or(""))
                    }
                    SessionEvent::ToolCallSettled { id, ok, .. } => format!("settled:{id}:{ok}"),
                };
                sink.lock().unwrap().push(tag);
            }));
        let (core, mut lines, mut wr) = rig(hooks, fast_limits());
        send_frame(
            &mut wr,
            json!({"type": "hello", "proto": 1, "activeTools": ["hub_read"], "tools": []}),
        )
        .await;
        send_frame(
            &mut wr,
            json!({"type": "event", "event": {"type": "agent_start"}}),
        )
        .await;
        send_frame(&mut wr, json!({"type": "partial", "text": "hel"})).await;
        send_frame(
            &mut wr,
            json!({"type": "tool_call", "id": "tc_9", "name": "hub_read", "args": {}}),
        )
        .await;
        // agent_done cancels anything still pending, so settle the call first.
        assert_eq!(recv_frame(&mut lines).await["type"], "tool_result");
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "hello:1:1".to_string(),
                "agent:agent_start".to_string(),
                "partial:hel".to_string(),
                "start:tc_9:hub_read:".to_string(),
                "settled:tc_9:true".to_string(),
            ]
        );
    }

    /// The 8 KiB output cap is a byte limit on UTF-8 text: a multibyte char
    /// straddling the limit must truncate at the boundary, not panic.
    #[test]
    fn bounded_truncates_on_a_char_boundary() {
        let value = "あ".repeat(3_000); // 9,000 bytes, byte 8192 mid-char
        let output = bounded(&value);
        assert!(output.ends_with("[output truncated]"));
        assert!(output.len() <= 8_192 + "\n[output truncated]".len());
    }

    /// The detail shown beside a tool name is the call's locating argument —
    /// the path, the command line, the URL — never file contents or bodies.
    #[test]
    fn tool_call_detail_picks_the_locating_argument() {
        for name in ["hub_read", "hub_write", "hub_edit", "hub_test"] {
            assert_eq!(
                tool_call_detail(name, &json!({"path": "src/app.ts"})).as_deref(),
                Some("src/app.ts")
            );
        }
        assert_eq!(
            tool_call_detail("hub_read_range", &json!({"path": "a.txt", "startLine": 40})).as_deref(),
            Some("a.txt:40")
        );
        assert_eq!(
            tool_call_detail("hub_read_range", &json!({"path": "a.txt", "startLine": 1})).as_deref(),
            Some("a.txt")
        );
        assert_eq!(tool_call_detail("hub_list", &json!({"path": ""})).as_deref(), Some("."));
        assert_eq!(
            tool_call_detail("hub_search", &json!({"query": "TODO", "path": "src"})).as_deref(),
            Some("\"TODO\"")
        );
        assert_eq!(
            tool_call_detail("hub_exec", &json!({"program": "node", "args": ["verify.cjs", "--fast"]})).as_deref(),
            Some("node verify.cjs --fast")
        );
        assert_eq!(tool_call_detail("hub_exec", &json!({"program": "node"})).as_deref(), Some("node"));
        assert_eq!(
            tool_call_detail("hub_http", &json!({"method": "POST", "url": "https://api.example.com/x"})).as_deref(),
            Some("POST https://api.example.com/x")
        );
        // Unknown tools and missing args yield no detail rather than a guess.
        assert_eq!(tool_call_detail("hub_read", &json!({})).is_none(), true);
        assert_eq!(tool_call_detail("mystery_tool", &json!({"path": "x"})).is_none(), true);
    }

    /// The detail string is one display line: control characters are stripped
    /// and the length is capped so a hostile arg cannot flood the row.
    #[test]
    fn tool_call_detail_is_single_line_and_bounded() {
        let detail = tool_call_detail(
            "hub_exec",
            &json!({"program": "node", "args": ["-e", &format!("{}\n\r{}", "x".repeat(200), "injected")] }),
        )
        .unwrap();
        assert!(detail.len() <= MAX_TOOL_DETAIL_CHARS);
        assert!(!detail.chars().any(|ch| ch.is_control()));
        assert!(!detail.contains("injected"));
    }

    /// The settle preview is a bounded excerpt of the result's first text
    /// block; errors surface their message; empty results emit nothing.
    #[test]
    fn result_preview_bounds_and_surfaces_errors() {
        let answer = Ok(ToolAnswer::text("line one\n".repeat(200)));
        let preview = result_preview(&answer).unwrap();
        assert!(preview.ends_with('…'));
        assert!(preview.chars().count() <= MAX_TOOL_PREVIEW_CHARS + 1);

        let error = Err("permission denied".to_string());
        assert_eq!(result_preview(&error).as_deref(), Some("permission denied"));

        let empty = Ok(ToolAnswer::new(json!([{"type": "text", "text": "  "}]), json!({})));
        assert!(result_preview(&empty).is_none());
        let no_text = Ok(ToolAnswer::new(json!([{"type": "image"}]), json!({})));
        assert!(result_preview(&no_text).is_none());
    }

    /// `partial` frames are the sidecar's compact token stream: each one
    /// surfaces on the observer as a delta, in order.
    #[tokio::test]
    async fn partial_frames_reach_the_observer_in_order() {
        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        let hooks =
            SidecarHooks::new(text_executor("unused")).with_observer(Arc::new(move |event| {
                if let SessionEvent::PartialOutput { text } = event {
                    sink.lock().unwrap().push_str(&text);
                }
            }));
        let (core, lines, mut wr) = rig(hooks, fast_limits());
        send_frame(&mut wr, json!({"type": "partial", "text": "答えは"})).await;
        send_frame(&mut wr, json!({"type": "partial", "text": "42"})).await;
        send_frame(&mut wr, json!({"type": "agent_done", "ok": true})).await;
        drop(lines);
        drop(wr);
        assert!(core.wait().await.unwrap());
        assert_eq!(*seen.lock().unwrap(), "答えは42");
    }

    /// Real-process smoke test for the spawn path. Requires `node` on PATH;
    /// run manually with `cargo test pi_sidecar -- --ignored`.
    #[tokio::test]
    #[ignore = "requires node on PATH"]
    async fn node_sidecar_smoke() {
        let script = r#"
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'hello', proto: 1, activeTools: ['hub_read'], tools: [{ name: 'hub_read', description: 'd', parameters: { type: 'object' } }] });
setTimeout(() => send({ type: 'tool_call', id: 'tc_1', name: 'hub_read', args: { path: 'x' } }), 20);
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'tool_result' || msg.type === 'tool_error') {
    send({ type: 'agent_done', ok: msg.type === 'tool_result' });
    process.exit(0);
  }
});
"#;
        let session = SidecarSession::spawn(
            SidecarSpec {
                program: PathBuf::from("node"),
                args: vec!["-e".to_string(), script.to_string()],
                workspace: std::env::temp_dir(),
                env: Vec::new(),
            },
            SidecarHooks::new(text_executor("from rust")),
        )
        .await
        .expect("spawn");
        wait_until(|| session.hello().is_some()).await;
        assert_eq!(
            session.active_tools().unwrap(),
            vec!["hub_read".to_string()]
        );
        assert_eq!(session.tools().unwrap()[0].name, "hub_read");
        session
            .send_partial(
                "tc_1",
                json!([{"type": "text", "text": "hub: working"}]),
                json!({}),
            )
            .await
            .expect("partial");
        let _ = session.stderr_tail();
        let outcome = session.wait().await.expect("session");
        assert!(outcome.ok);
        assert_eq!(outcome.exit_code, Some(0));
    }

    /// Full real-model E2E against the pi-poc sidecar: spawns
    /// `node pi-sidecar.mjs <model> <prompt>`, resolves a real provider model
    /// (default: local Ollama via `~/.pi/agent/models.json`), and routes every
    /// `tool_call` to `agent_tools_executor` against a seeded workspace.
    ///
    /// Manual run: `cargo test pi_sidecar -- --ignored`
    /// Knobs:
    ///   `PI_SIDECAR_SCRIPT` — sidecar path
    ///     (default `%TEMP%\pi-poc\app\pi-sidecar.mjs`)
    ///   `PI_SIDECAR_MODEL`  — "provider/modelId" (default
    ///     `ollama/qwen2.5:1.5b`)
    ///   `PI_SIDECAR_PROMPT` — prompt override (default asks for notes.txt)
    ///
    /// This proves the live wire end-to-end; it is not a CI gate. Missing
    /// script/node, an unreachable model, and model-side flakes (no tool_call,
    /// refused args, agent_done ok=false) all skip with an observation log
    /// rather than panic — what must not skip is a transport-level break.
    #[tokio::test]
    #[ignore = "requires node, the pi-poc sidecar script, and a reachable model (default: local Ollama)"]
    async fn node_pi_sidecar_real_model_file_read() {
        let script = std::env::var("PI_SIDECAR_SCRIPT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::temp_dir()
                    .join("pi-poc")
                    .join("app")
                    .join("pi-sidecar.mjs")
            });
        if !script.is_file() {
            eprintln!(
                "[pi_sidecar e2e] skip: sidecar script not found at {}",
                script.display()
            );
            return;
        }
        let model =
            std::env::var("PI_SIDECAR_MODEL").unwrap_or_else(|_| "ollama/qwen2.5:1.5b".to_string());
        // Fail fast for the default local provider when nothing is listening.
        if model.starts_with("ollama/")
            && std::net::TcpStream::connect_timeout(
                &"127.0.0.1:11434".parse().expect("socket addr"),
                Duration::from_millis(500),
            )
            .is_err()
        {
            eprintln!("[pi_sidecar e2e] skip: ollama not reachable on 127.0.0.1:11434");
            return;
        }
        let prompt = std::env::var("PI_SIDECAR_PROMPT").unwrap_or_else(|_| {
            "Call the hub_read tool with path \"notes.txt\" to read that file, then tell me the answer it contains."
                .to_string()
        });

        let (_guard, root) = seeded_workspace();
        std::fs::write(
            root.join("notes.txt"),
            "The answer to the test question is 42.\n",
        )
        .unwrap();

        // Record every call that reaches the executor — proof the wire feeds
        // agent_tools — and mirror every session event for the diagnosis log.
        let calls = Arc::new(Mutex::new(Vec::<(String, Value, bool)>::new()));
        let inner = agent_tools_executor(root.clone());
        let seen = calls.clone();
        let executor = Arc::new(move |name: String, args: Value| {
            let inner = inner.clone();
            let seen = seen.clone();
            async move {
                let result = inner.execute(name.clone(), args.clone()).await;
                seen.lock().unwrap().push((name, args, result.is_ok()));
                result
            }
        });
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = events.clone();
        let hooks = SidecarHooks::new(executor).with_observer(Arc::new(move |event| {
            let tag = match event {
                SessionEvent::Hello {
                    proto,
                    active_tools,
                    ..
                } => {
                    format!("hello proto={proto} active={active_tools:?}")
                }
                SessionEvent::AgentEvent(value) => {
                    let kind = value["type"].as_str().unwrap_or("?");
                    match kind {
                        "tool_execution_start" => format!(
                            "agent:exec_start {}",
                            value["toolName"].as_str().unwrap_or("?")
                        ),
                        "tool_execution_end" => format!(
                            "agent:exec_end {} isError={}",
                            value["toolName"].as_str().unwrap_or("?"),
                            value["isError"]
                        ),
                        "message_end" => {
                            let role = value["message"]["role"].as_str().unwrap_or("?");
                            let body = value["message"]["content"]
                                .as_array()
                                .map(|blocks| {
                                    blocks
                                        .iter()
                                        .map(|block| match block["type"].as_str() {
                                            Some("text") => {
                                                block["text"].as_str().unwrap_or("").to_string()
                                            }
                                            Some("toolCall") => format!(
                                                "<call:{}>",
                                                block["name"].as_str().unwrap_or("?")
                                            ),
                                            _ => String::new(),
                                        })
                                        .collect::<Vec<_>>()
                                        .join("")
                                })
                                .unwrap_or_default();
                            format!("agent:{role} {body:?}")
                        }
                        _ => format!("agent:{kind}"),
                    }
                }
                SessionEvent::PartialOutput { text } => format!("partial:{text}"),
                SessionEvent::ToolCallStarted { id, name, .. } => format!("start:{id}:{name}"),
                SessionEvent::ToolCallSettled { id, ok, .. } => format!("settled:{id}:{ok}"),
            };
            sink.lock().unwrap().push(tag);
        }));
        let limits = SidecarLimits {
            session: Duration::from_secs(240),
            tool_call: Duration::from_secs(60),
            drain: Duration::from_secs(10),
        };
        let session = match SidecarSession::spawn_with_limits(
            SidecarSpec {
                program: PathBuf::from("node"),
                // Model + prompt travel as argv so the test never mutates the
                // process environment; the script also honors PI_SIDECAR_*.
                args: vec![script.to_string_lossy().into_owned(), model.clone(), prompt],
                workspace: root.clone(),
                env: Vec::new(),
            },
            hooks,
            limits,
        )
        .await
        {
            Ok(session) => session,
            Err(error) => {
                eprintln!("[pi_sidecar e2e] skip: spawn failed: {error}");
                return;
            }
        };
        // Let the hello handshake + startup stderr settle (model resolution,
        // resource load) before snapshotting diagnostics and waiting out the
        // run. Missing hello is handled through the outcome below.
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while session.hello().is_none() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let stderr = session.stderr_tail();
        let outcome = match session.wait().await {
            Ok(outcome) => outcome,
            Err(error) => panic!(
                "sidecar transport failed: {error}\nstderr tail:\n{stderr}\nevents:\n{}",
                events.lock().unwrap().join("\n")
            ),
        };
        let log = events.lock().unwrap();
        eprintln!("[pi_sidecar e2e] events:\n{}", log.join("\n"));
        eprintln!("[pi_sidecar e2e] stderr tail:\n{stderr}");
        if !outcome.ok {
            // The sidecar answers agent_done ok=false when the model cannot be
            // resolved or prompt() throws — a model-side condition, not a
            // transport break.
            eprintln!("[pi_sidecar e2e] skip: sidecar ended agent_done ok=false (model unreachable or prompt failed)");
            return;
        }
        // The sidecar process exits 0 right after agent_done.
        assert_eq!(outcome.exit_code, Some(0));
        assert!(
            log.iter()
                .any(|l| l.starts_with("hello proto=1") && l.contains("hub_read")),
            "sidecar hello did not advertise hub_read"
        );
        let calls = calls.lock().unwrap();
        if calls.is_empty() {
            eprintln!(
                "[pi_sidecar e2e] skip: model produced no tool_call this run (model-side flake)"
            );
            return;
        }
        eprintln!("[pi_sidecar e2e] executor calls: {calls:?}");
        // The semantic check only applies when a hub_read actually served the
        // file: a run that only listed, or whose reads were refused on bad
        // args, exercised the wire but says nothing about the answer.
        if !calls.iter().any(|(name, _, ok)| name == "hub_read" && *ok) {
            eprintln!(
                "[pi_sidecar e2e] skip: no successful hub_read this run (model arg flakiness)"
            );
            return;
        }
        // The model should fold the served file body into its final answer.
        assert!(
            log.iter()
                .any(|l| l.starts_with("agent:assistant") && l.contains("42")),
            "final assistant text did not reflect the file contents"
        );
    }

    fn seeded_workspace() -> (agent_tools::TestWorkspace, PathBuf) {
        let path = std::env::temp_dir().join(format!("hub-pi-sidecar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let path = path.canonicalize().unwrap();
        std::fs::write(path.join("a.txt"), "hello pi").unwrap();
        std::fs::create_dir(path.join("sub")).unwrap();
        std::fs::write(path.join("sub").join("b.txt"), "nested").unwrap();
        (agent_tools::TestWorkspace { path: path.clone() }, path)
    }

    #[tokio::test]
    async fn discovery_does_not_grant_edit_observations_or_consume_their_capacity() {
        let (_guard, root) = seeded_workspace();
        let executor = agent_tools_executor_with_write(root.clone(), true);
        for index in 0..20 {
            let path = format!("read-{index}.txt");
            std::fs::write(root.join(&path), "read-only discovery").unwrap();
            executor
                .execute("hub_read_range".into(), json!({"path":path}))
                .await
                .unwrap();
        }
        let found = executor
            .execute("hub_search".into(), json!({"query":"hello"}))
            .await
            .unwrap();
        assert_eq!(found.details["matches"][0]["path"], "a.txt");
        executor
            .execute("hub_read_range".into(), json!({"path":"a.txt"}))
            .await
            .unwrap();
        let error = executor
            .execute(
                "hub_write".into(),
                json!({"path":"a.txt","content":"unsafe"}),
            )
            .await
            .unwrap_err();
        assert_eq!(error, "read_before_write_required");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello pi"
        );
        executor
            .execute("hub_read".into(), json!({"path":"a.txt"}))
            .await
            .unwrap();
        executor
            .execute(
                "hub_write".into(),
                json!({"path":"a.txt","content":"observed"}),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "observed"
        );
    }

    #[test]
    fn command_and_test_status_requires_zero_exit_and_no_timeout() {
        for value in [
            json!({"exitCode":0,"timedOut":true}),
            json!({"exitCode":null,"timedOut":false}),
            json!({"exitCode":1,"timedOut":false}),
            json!({"exitCode":0}),
            json!({}),
        ] {
            assert!(execution_result("test_failed", value)
                .unwrap_err()
                .starts_with("test_failed: "));
        }
        assert!(execution_result("test_failed", json!({"exitCode":0,"timedOut":false})).is_ok());
    }

    #[tokio::test]
    #[ignore = "requires node and the rebuilt vendored Pi SDK bundle; no model or credentials"]
    async fn vendored_pi_sdk_repairs_and_verifies_with_real_tools() {
        // The standard engine was deleted (2026-10-18); these Hub-tool fixtures run on dsh.
        for (engine, scenario) in [("dsh", "repair"), ("dsh", "review")] {
            let (_guard, root) = seeded_workspace();
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../vendor/pi-sidecar/pi-sidecar.mjs")
                .canonicalize()
                .unwrap();
            std::fs::write(root.join("notes.txt"), "answer=41\n").unwrap();
            let (approver, seen) = recording_approver(true);
            let reviews = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed_reviews = reviews.clone();
            let executor = hub_executor(
                root.clone(),
                false,
                HubToolCaps {
                    exec: true,
                    ..HubToolCaps::default()
                },
                Some(approver),
            );
            let result = SidecarSession::spawn(
                SidecarSpec {
                    program: "node".into(),
                    args: vec![crate::pi_work::non_verbatim(script)
                        .to_string_lossy()
                        .into_owned()],
                    workspace: root.clone(),
                    env: vec![
                        ("PI_POC_SCENARIO".into(), scenario.into()),
                        ("PI_SIDECAR_CAPS".into(), "exec".into()),
                        ("PI_WORK_ENGINE".into(), engine.into()),
                        (
                            "PI_SIDECAR_CWD".into(),
                            crate::pi_work::non_verbatim(root.clone())
                                .to_string_lossy()
                                .into_owned(),
                        ),
                        (
                            "PI_CODING_AGENT_DIR".into(),
                            crate::pi_work::non_verbatim(root.join("config"))
                                .to_string_lossy()
                                .into_owned(),
                        ),
                    ],
                },
                SidecarHooks::new(executor).with_observer(Arc::new(move |event| {
                    if let SessionEvent::AgentEvent(event) = event {
                        if event["type"] == "message_end"
                            && event["message"]["role"] == "user"
                            && event["message"]["content"]
                                .to_string()
                                .contains("Hub execution evidence")
                        {
                            observed_reviews.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                })),
            )
            .await
            .unwrap()
            .wait()
            .await
            .unwrap();
            assert!(result.ok, "{result:?}");
            assert_eq!(
                std::fs::read_to_string(root.join("notes.txt")).unwrap(),
                "answer=42\n"
            );
            assert_eq!(
                seen.lock()
                    .unwrap()
                    .iter()
                    .map(|request| request.tool.as_str())
                    .collect::<Vec<_>>(),
                if scenario == "repair" {
                    vec!["hub_exec", "hub_edit", "hub_exec"]
                } else {
                    vec!["hub_edit"]
                }
            );
            assert_eq!(
                reviews.load(std::sync::atomic::Ordering::SeqCst),
                0
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires node and the rebuilt vendored Pi SDK bundle; no model or credentials"]
    async fn vendored_pi_sdk_provider_error_is_not_reported_as_success() {
        let (_guard, root) = seeded_workspace();
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../vendor/pi-sidecar/pi-sidecar.mjs")
            .canonicalize()
            .unwrap();
        let result = SidecarSession::spawn(
            SidecarSpec {
                program: "node".into(),
                args: vec![crate::pi_work::non_verbatim(script)
                    .to_string_lossy()
                    .into_owned()],
                workspace: root.clone(),
                env: vec![
                    ("PI_POC_SCENARIO".into(), "provider-error".into()),
                    (
                        "PI_CODING_AGENT_DIR".into(),
                        crate::pi_work::non_verbatim(root.join("config"))
                            .to_string_lossy()
                            .into_owned(),
                    ),
                ],
            },
            SidecarHooks::new(agent_tools_executor(root)),
        )
        .await
        .unwrap()
        .wait()
        .await
        .unwrap();
        assert!(!result.ok, "{result:?}");
    }

    #[tokio::test]
    async fn agent_tools_executor_lists_and_reads_real_files() {
        let (_guard, root) = seeded_workspace();
        let executor = agent_tools_executor(root);

        let list = executor
            .execute("hub_list".into(), json!({"path": ""}))
            .await
            .expect("list");
        let entries = list.details["entries"].as_array().expect("entries");
        assert!(entries.iter().any(|e| e["path"] == "a.txt"));
        assert!(entries
            .iter()
            .any(|e| e["path"] == "sub" && e["directory"] == true));

        let read = executor
            .execute("hub_read".into(), json!({"path": "a.txt"}))
            .await
            .expect("read");
        assert_eq!(read.details["content"], "hello pi");
        assert_eq!(read.content[0]["text"], "hello pi");

        // The shared Files records observations across the session: a second
        // read of the same path still succeeds, capacity is shared.
        let nested = executor
            .execute("hub_read".into(), json!({"path": "sub/b.txt"}))
            .await
            .expect("nested read");
        assert_eq!(nested.details["content"], "nested");
    }

    #[tokio::test]
    async fn agent_tools_executor_preserves_empty_escaped_and_bounded_file_content() {
        let (_guard, root) = seeded_workspace();
        let executor = agent_tools_executor(root.clone());
        for (index, expected) in [
            String::new(),
            "\r\nconst text = '\\n';\n// 日本語 😀\t\\server\n".into(),
            r#"{"content":"this is file content, not a tool envelope"}"#.into(),
            "x".repeat(agent_tools::MAX_RESULT_BYTES),
        ]
        .into_iter()
        .enumerate()
        {
            let path = format!("read-{index}.txt");
            std::fs::write(root.join(&path), &expected).unwrap();
            let read = executor
                .execute("hub_read".into(), json!({"path":path}))
                .await
                .unwrap();
            assert_eq!(read.content, json!([{"type":"text","text":expected}]));
            assert_eq!(read.details["content"], expected);
            assert_eq!(read.details["sizeBytes"], expected.len());
        }
        std::fs::write(root.join("oversize.txt"), "x".repeat(agent_tools::MAX_FILE_BYTES + 1)).unwrap();
        assert_eq!(executor.execute("hub_read".into(), json!({"path":"oversize.txt"})).await.err().as_deref(), Some("file_too_large"));
    }

    #[tokio::test]
    async fn agent_tools_executor_refuses_mutations_and_unknown_tools() {
        let executor = agent_tools_executor(std::env::temp_dir());
        // Mutating kinds stay closed without the session-level write grant.
        for name in ["hub_write", "hub_edit"] {
            let error = executor
                .execute(
                    name.into(),
                    json!({"path": "a.txt", "content": "x", "summary": "y"}),
                )
                .await
                .unwrap_err();
            assert_eq!(error, "write_not_permitted", "{name}");
        }
        // Code execution needs the Docker snapshot harness; denied without the cap.
        assert_eq!(
            executor
                .execute(
                    "hub_test".into(),
                    json!({"path": "python", "content": "print(1)", "summary": "t"})
                )
                .await
                .unwrap_err(),
            "test_not_permitted"
        );
        // hub_finish is session control, not a write: it terminates the loop.
        let finish = executor
            .execute("hub_finish".into(), json!({"summary": "done"}))
            .await
            .expect("finish");
        assert_eq!(finish.terminate, Some(true));
        assert_eq!(
            executor
                .execute("hub_shell".into(), json!({"path": "a.txt"}))
                .await
                .unwrap_err(),
            "unknown_tool"
        );
    }

    #[tokio::test]
    async fn agent_tools_executor_with_write_applies_and_verifies_changes() {
        let (_guard, root) = seeded_workspace();
        let executor = agent_tools_executor_with_write(root.clone(), true);

        // Overwriting an existing file requires an observed read first; a
        // brand-new path may be written without one.
        let unread = executor
            .execute(
                "hub_write".into(),
                json!({"path": "a.txt", "content": "fresh", "summary": "create"}),
            )
            .await;
        assert_eq!(
            unread.unwrap_err(),
            "read_before_write_required",
            "overwrites need an observed read first"
        );
        executor
            .execute(
                "hub_write".into(),
                json!({"path": "new.txt", "content": "fresh", "summary": "create"}),
            )
            .await
            .expect("new file write");
        assert_eq!(
            std::fs::read_to_string(root.join("new.txt")).unwrap(),
            "fresh"
        );

        // Read → write → the file actually changes on disk.
        executor
            .execute("hub_read".into(), json!({"path": "a.txt"}))
            .await
            .expect("read");
        let written = executor
            .execute(
                "hub_write".into(),
                json!({"path": "a.txt", "content": "hello sidecar", "summary": "replace body"}),
            )
            .await
            .expect("write");
        assert_eq!(written.details["path"], "a.txt");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello sidecar"
        );

        // Edit applies oldText→newText against the last observed content.
        let edited = executor
            .execute(
                "hub_edit".into(),
                json!({"path": "a.txt", "content": serde_json::to_string(&json!({"oldText":"sidecar","newText":"hub"})).unwrap(), "summary": "rename"}),
            )
            .await
            .expect("edit");
        assert_eq!(edited.details["path"], "a.txt");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello hub"
        );

        // Edit against stale/absent text is refused without touching the file.
        assert_eq!(
            executor
                .execute(
                    "hub_edit".into(),
                    json!({"path": "a.txt", "content": serde_json::to_string(&json!({"oldText":"missing","newText":"x"})).unwrap(), "summary": "x"}),
                )
                .await
                .unwrap_err(),
            "edit_not_found"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello hub"
        );
    }

    #[tokio::test]
    async fn agent_tools_executor_with_write_still_confines_paths() {
        let (_guard, root) = seeded_workspace();
        let executor = agent_tools_executor_with_write(root.clone(), true);
        for name in ["hub_read", "hub_write"] {
            assert!(executor
                .execute(
                    name.into(),
                    json!({"path": "../escape.txt", "content": "x", "summary": "x"})
                )
                .await
                .is_err());
        }
        // The revision archive the writer creates stays under the workspace.
        let archive = root.join(".hub-local-runner").join("revisions");
        if archive.exists() {
            assert!(archive
                .canonicalize()
                .unwrap()
                .starts_with(root.canonicalize().unwrap()));
        }
    }

    #[tokio::test]
    async fn agent_tools_executor_confines_and_validates_paths() {
        let (_guard, root) = seeded_workspace();
        let executor = agent_tools_executor(root);
        let long = "x".repeat(241);
        for path in ["../a", "a/../b", "C:/a", "/a", long.as_str()] {
            assert!(
                executor
                    .execute("hub_read".into(), json!({"path": path}))
                    .await
                    .is_err(),
                "{path}"
            );
        }
        // Non-object args and fields outside the Action shape are refused.
        assert!(executor
            .execute("hub_read".into(), json!("a.txt"))
            .await
            .is_err());
        assert!(executor
            .execute("hub_read".into(), json!({"path": "a.txt", "extra": true}))
            .await
            .is_err());
    }

    /// Thin engine: Pi's native file operations exist only when the run is a thin run,
    /// writes keep per-action approval (with a real preview), and bash is plain hub_exec
    /// (absent without allowExec, individually approved with it).
    #[tokio::test]
    async fn thin_engine_file_operations_are_gated_like_hub_tools() {
        let (_guard, root) = seeded_workspace();
        let abs = |rel: &str| format!("{}/{rel}", root.to_string_lossy().trim_start_matches(r"\\?\"));
        let plain = hub_executor(root.clone(), true, HubToolCaps::default(), None);
        assert_eq!(plain.execute("hub_fs".into(), json!({"op":"read","path":abs("a.txt")})).await.err().as_deref(), Some("unknown_tool"));
        let thin = HubToolCaps { native_fs: true, ..HubToolCaps::default() };
        let (deny, seen) = recording_approver(false);
        let gated = hub_executor(root.clone(), false, thin, Some(deny));
        let read = gated.execute("hub_fs".into(), json!({"op":"read","path":abs("a.txt")})).await.unwrap();
        assert_eq!(read.details["content"], "hello pi");
        assert_eq!(gated.execute("hub_fs_write".into(), json!({"op":"write","path":abs("a.txt"),"content":"x"})).await.err().as_deref(), Some("approval_denied"));
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "hello pi");
        {
            let requests = seen.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].tool, "hub_write");
            assert_eq!(requests[0].detail["before"], "hello pi", "the operator sees the real previous content");
        }
        assert!(gated.execute("hub_fs_write".into(), json!({"op":"write","path":abs("../x.txt"),"content":"x"})).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 1, "an escape is refused before any approval");
        assert_eq!(gated.execute("hub_exec".into(), json!({"program":"node","args":["-e","1"]})).await.err().as_deref(), Some("exec_not_permitted"));
        let no_approver = hub_executor(root.clone(), false, thin, None);
        assert_eq!(no_approver.execute("hub_fs_write".into(), json!({"op":"write","path":abs("a.txt"),"content":"x"})).await.err().as_deref(), Some("write_not_permitted"));
        let (allow, _) = recording_approver(true);
        let granted = hub_executor(root.clone(), true, HubToolCaps { exec: true, ..thin }, Some(allow));
        granted.execute("hub_fs_write".into(), json!({"op":"mkdir","path":abs("new/dir")})).await.unwrap();
        granted.execute("hub_fs_write".into(), json!({"op":"write","path":abs("new/dir/b.txt"),"content":"thin"})).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("new/dir/b.txt")).unwrap(), "thin");
    }

    /// Thin resume (2026-10-18): native reads checkpoint as path + SHA-256 only; on resume Hub
    /// re-reads each one, a changed file must be read again before a whole-file write, and the
    /// fresh executor keeps the workspace boundary (escapes and junctions) and approvals.
    #[tokio::test]
    async fn thin_resume_re_verifies_native_reads_and_keeps_the_boundary() {
        let (_guard, root) = seeded_workspace();
        let abs = |rel: &str| format!("{}/{rel}", root.to_string_lossy().trim_start_matches(r"\\?\"));
        let thin = HubToolCaps { native_fs: true, ..HubToolCaps::default() };
        let first = Arc::new(Mutex::new(Files::default()));
        let (allow, _) = recording_approver(true);
        let run = hub_executor_sharing_files(root.clone(), true, thin, Some(allow), first.clone());
        run.execute("hub_fs".into(), json!({"op":"read","path":abs("a.txt")})).await.unwrap();
        run.execute("hub_fs".into(), json!({"op":"read","path":abs("sub/b.txt")})).await.unwrap();
        run.execute("hub_fs".into(), json!({"op":"stat","path":abs("sub")})).await.unwrap();
        let hashes = first.lock().unwrap().observation_hashes();
        assert_eq!(hashes.keys().cloned().collect::<Vec<_>>(), vec!["a.txt".to_owned(), "sub/b.txt".to_owned()]);
        assert_eq!(hashes["a.txt"], agent_tools::digest(b"hello pi"));
        assert!(!format!("{hashes:?}").contains("hello pi"), "records hold no file content");

        // The file changes while the app is closed; the other stays as read.
        std::fs::write(root.join("a.txt"), "changed on disk").unwrap();
        let mut restored = Files::default();
        assert_eq!(restored.restore_native_reads(&root, &hashes), 1);
        let resumed = Arc::new(Mutex::new(restored));
        let (gate, seen) = recording_approver(true);
        // Fresh permissions: no session write grant this time, so every write parks.
        let run = hub_executor_sharing_files(root.clone(), false, thin, Some(gate), resumed.clone());
        assert_eq!(run.execute("hub_fs_write".into(), json!({"op":"write","path":abs("a.txt"),"content":"stale"})).await.err().as_deref(),
            Some("resume_reread_required"));
        assert!(seen.lock().unwrap().is_empty(), "refused before any approval");
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "changed on disk");
        run.execute("hub_fs_write".into(), json!({"op":"write","path":abs("sub/b.txt"),"content":"nested 2"})).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1, "the unchanged file's write still needs its approval");

        // The boundary is the executor's, not the checkpoint's: escapes and junctions stay refused.
        let outside = std::env::temp_dir().join(format!("hub-thin-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "OUTSIDE").unwrap();
        let link = root.join("linked");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", link.to_string_lossy().trim_start_matches(r"\\?\"), outside.to_string_lossy().as_ref()])
            .output().unwrap();
        assert!(made.status.success());
        for path in [abs("../x.txt"), abs("linked/secret.txt")] {
            assert!(run.execute("hub_fs".into(), json!({"op":"read","path":path})).await.is_err(), "{path}");
            assert!(run.execute("hub_fs_write".into(), json!({"op":"write","path":path,"content":"x"})).await.is_err(), "{path}");
        }
        std::fs::remove_dir(&link).unwrap();
        assert_eq!(std::fs::read_to_string(outside.join("secret.txt")).unwrap(), "OUTSIDE");
        let _ = std::fs::remove_dir_all(&outside);
        assert_eq!(seen.lock().unwrap().len(), 1, "no refused path reached an approval");

        // A fresh read clears the stale mark; the next checkpoint records the new content's hash.
        run.execute("hub_fs".into(), json!({"op":"read","path":abs("a.txt")})).await.unwrap();
        run.execute("hub_fs_write".into(), json!({"op":"write","path":abs("a.txt"),"content":"fresh"})).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "fresh");
        assert_eq!(resumed.lock().unwrap().observation_hashes()["a.txt"], agent_tools::digest(b"fresh"));
        // A file removed since the checkpoint is simply dropped: creating it anew needs no read.
        let mut gone = Files::default();
        std::fs::remove_file(root.join("sub/b.txt")).unwrap();
        assert_eq!(gone.restore_native_reads(&root, &hashes), 0);
        assert!(gone.native_write_allowed("sub/b.txt").is_ok());
    }

    fn recording_approver(approve: bool) -> (PiApprover, Arc<Mutex<Vec<PiApprovalRequest>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let approver: PiApprover = Arc::new(move |request: PiApprovalRequest| {
            sink.lock().unwrap().push(request);
            Box::pin(async move {
                PiDecision {
                    approved: approve,
                    outcome: None,
                }
            })
        });
        (approver, seen)
    }

    /// The gated path: a valid mutation becomes a request built from the
    /// parsed action; approving runs the ordinary preview→write flow.
    #[tokio::test]
    async fn approval_executor_asks_then_applies_writes() {
        let (_guard, root) = seeded_workspace();
        let (approver, seen) = recording_approver(true);
        let executor = agent_tools_executor_with_approval(root.clone(), false, Some(approver));

        // Read-only kinds never ask.
        executor
            .execute("hub_list".into(), json!({"path": ""}))
            .await
            .expect("list");
        executor
            .execute("hub_read".into(), json!({"path": "a.txt"}))
            .await
            .expect("read");
        assert!(seen.lock().unwrap().is_empty());

        executor
            .execute(
                "hub_write".into(),
                json!({"path": "new.txt", "content": "hello", "summary": "greeting"}),
            )
            .await
            .expect("approved write");
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].tool, "hub_write");
            assert_eq!(seen[0].summary, "write new.txt (5 bytes) — greeting");
            assert_eq!(seen[0].detail["before"], "");
            assert_eq!(seen[0].detail["after"], "hello");
            assert_eq!(seen[0].detail["path"], "new.txt");
            assert!(seen[0].detail["previousSha256"].is_null());
        }
        assert_eq!(
            std::fs::read_to_string(root.join("new.txt")).unwrap(),
            "hello"
        );

        // hub_edit asks too, after the usual observed read.
        executor
            .execute(
                "hub_edit".into(),
                json!({
                    "path": "a.txt",
                    "content": serde_json::to_string(&json!({"oldText":"pi","newText":"hub"})).unwrap(),
                    "summary": ""
                }),
            )
            .await
            .expect("approved edit");
        assert_eq!(seen.lock().unwrap()[1].summary, "edit a.txt");
        assert_eq!(seen.lock().unwrap()[1].detail["before"], "hello pi");
        assert_eq!(seen.lock().unwrap()[1].detail["after"], "hello hub");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello hub"
        );
    }

    /// Denial answers `approval_denied` and touches nothing; malformed and
    /// unapprovable calls keep their own refusals and never reach the
    /// approver — a human only ever sees a description of a valid action.
    #[tokio::test]
    async fn approval_executor_denies_and_never_asks_unapprovable() {
        let (_guard, root) = seeded_workspace();
        let (approver, seen) = recording_approver(false);
        let executor = agent_tools_executor_with_approval(root.clone(), false, Some(approver));

        assert_eq!(
            executor
                .execute(
                    "hub_write".into(),
                    json!({"path": "new.txt", "content": "x", "summary": ""})
                )
                .await
                .unwrap_err(),
            "approval_denied"
        );
        assert!(!root.join("new.txt").exists());
        assert_eq!(seen.lock().unwrap().len(), 1);

        assert_eq!(
            executor
                .execute(
                    "hub_write".into(),
                    json!({"path":"a.txt","content":"unread"})
                )
                .await
                .unwrap_err(),
            "read_before_write_required"
        );
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "invalid changes must not ask for approval"
        );

        assert_eq!(
            executor
                .execute("hub_write".into(), json!("not an object"))
                .await
                .unwrap_err(),
            "invalid_action"
        );
        assert_eq!(
            executor
                .execute(
                    "hub_edit".into(),
                    json!({"path": "a.txt", "content": "not json", "summary": ""})
                )
                .await
                .unwrap_err(),
            "edit_invalid"
        );
        assert_eq!(
            executor
                .execute(
                    "hub_test".into(),
                    json!({"path": "python", "content": "print(1)", "summary": "t"})
                )
                .await
                .unwrap_err(),
            "test_not_permitted"
        );
        assert_eq!(
            executor
                .execute("hub_finish".into(), json!({"summary": "done"}))
                .await
                .unwrap()
                .terminate,
            Some(true)
        );
        // Everything after the first denial stayed away from the approver.
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// The session-level grant bypasses approval entirely: the approver is
    /// never consulted even though one was supplied.
    #[tokio::test]
    async fn approval_executor_with_write_grant_skips_the_approver() {
        let (_guard, root) = seeded_workspace();
        // Would deny if asked; the grant means it is never asked.
        let (approver, seen) = recording_approver(false);
        let executor = agent_tools_executor_with_approval(root.clone(), true, Some(approver));
        executor
            .execute(
                "hub_write".into(),
                json!({"path": "new.txt", "content": "x", "summary": ""}),
            )
            .await
            .expect("granted write");
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "x");
    }

    #[tokio::test]
    async fn approval_executor_does_not_rebase_an_edit_after_a_concurrent_read() {
        let (_guard, root) = seeded_workspace();
        let waiting = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let approver: PiApprover = {
            let waiting = Arc::clone(&waiting);
            let release = Arc::clone(&release);
            Arc::new(move |request| {
                assert_eq!(request.detail["before"], "hello pi");
                assert_eq!(request.detail["after"], "hello hub");
                let release = Arc::clone(&release);
                waiting.notify_one();
                Box::pin(async move {
                    release.notified().await;
                    PiDecision {
                        approved: true,
                        outcome: None,
                    }
                })
            })
        };
        let executor = agent_tools_executor_with_approval(root.clone(), false, Some(approver));
        executor
            .execute("hub_read".into(), json!({"path": "a.txt"}))
            .await
            .unwrap();
        let edit = {
            let executor = Arc::clone(&executor);
            tokio::spawn(async move {
                executor.execute("hub_edit".into(), json!({"path": "a.txt", "content": "{\"oldText\":\"pi\",\"newText\":\"hub\"}"})).await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), waiting.notified())
            .await
            .unwrap();
        std::fs::write(root.join("a.txt"), "another pi edit").unwrap();
        executor
            .execute("hub_read".into(), json!({"path": "a.txt"}))
            .await
            .unwrap();
        release.notify_one();
        let result = tokio::time::timeout(Duration::from_secs(2), edit)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "file_changed_since_approval");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "another pi edit"
        );
    }

    /// hub_exec/hub_http refuse before parsing when the run didn't opt in —
    /// the capability flags, not the approver, are the first boundary.
    #[tokio::test]
    async fn operator_tools_refuse_when_the_run_did_not_opt_in() {
        let (_guard, root) = seeded_workspace();
        let (approver, seen) = recording_approver(true);
        let executor = hub_executor(root, false, HubToolCaps::default(), Some(approver));
        assert_eq!(
            executor
                .execute("hub_exec".into(), json!({"program": "cmd"}))
                .await
                .unwrap_err(),
            "exec_not_permitted"
        );
        assert_eq!(
            executor
                .execute(
                    "hub_http".into(),
                    json!({"method": "GET", "url": "https://x/"})
                )
                .await
                .unwrap_err(),
            "http_not_permitted"
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    /// hub_web_search follows the hub_http switch: off without allowHttp, a
    /// missing approver fails closed, denial shows query and engines and never
    /// reaches the network. (No approval is granted here, so no search runs.)
    #[tokio::test]
    async fn web_search_tool_needs_allow_http_and_an_individual_approval() {
        let (_guard, root) = seeded_workspace();
        let (approver, seen) = recording_approver(true);
        let off = hub_executor(root.clone(), true, HubToolCaps::default(), Some(approver));
        assert_eq!(
            off.execute("hub_web_search".into(), json!({"query": "rust"})).await.unwrap_err(),
            "http_not_permitted"
        );
        assert!(seen.lock().unwrap().is_empty());

        let caps = HubToolCaps { http: true, ..HubToolCaps::default() };
        let none = hub_executor(root.clone(), true, caps, None);
        assert_eq!(
            none.execute("hub_web_search".into(), json!({"query": "rust"})).await.unwrap_err(),
            "approval_required"
        );
        assert_eq!(
            none.execute("hub_web_search".into(), json!({"query": ""})).await.unwrap_err(),
            "query_invalid"
        );

        let (deny, seen) = recording_approver(false);
        let denied = hub_executor(root, true, caps, Some(deny));
        assert_eq!(
            denied.execute("hub_web_search".into(), json!({"query": "rust", "engines": ["duckduckgo"]})).await.unwrap_err(),
            "approval_denied"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].tool, "hub_web_search");
        assert!(seen[0].summary.contains("rust") && seen[0].summary.contains("wikipedia_ja") && !seen[0].summary.contains("duckduckgo"));
    }

    /// allow_write is a file grant only: an enabled hub_exec still parks on
    /// an individual decision, and denial runs nothing.
    #[tokio::test]
    async fn operator_tools_ignore_the_write_grant_and_deny_cleanly() {
        let (_guard, root) = seeded_workspace();
        let (approver, seen) = recording_approver(false);
        let executor = hub_executor(
            root.clone(),
            true,
            HubToolCaps {
                exec: true,
                http: true,
                ..HubToolCaps::default()
            },
            Some(approver),
        );
        assert_eq!(
            executor
                .execute(
                    "hub_exec".into(),
                    json!({"program": "cmd", "args": ["/c", "echo hi"]}),
                )
                .await
                .unwrap_err(),
            "approval_denied"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].tool, "hub_exec");
        assert_eq!(
            seen[0].summary,
            format!("exec {}", json!({
                "program": "cmd", "args": ["/c", "echo hi"], "cwd": "",
                "stdin": null, "timeoutMs": 120_000
            }))
        );
    }

    /// An enabled hub_exec without an approver fails closed rather than
    /// running anything.
    #[tokio::test]
    async fn operator_tools_fail_closed_without_an_approver() {
        let (_guard, root) = seeded_workspace();
        let executor = hub_executor(
            root,
            true,
            HubToolCaps {
                exec: true,
                http: false,
                ..HubToolCaps::default()
            },
            None,
        );
        assert_eq!(
            executor
                .execute(
                    "hub_exec".into(),
                    json!({"program": "cmd", "args": ["/c", "echo hi"]})
                )
                .await
                .unwrap_err(),
            "approval_required"
        );
    }

    /// Approved hub_exec runs the real command confined to the workspace and
    /// returns bounded output.
    #[tokio::test]
    async fn approved_exec_runs_the_command() {
        let (_guard, root) = seeded_workspace();
        let (approver, _seen) = recording_approver(true);
        let executor = hub_executor(
            root.clone(),
            false,
            HubToolCaps {
                exec: true,
                http: false,
                ..HubToolCaps::default()
            },
            Some(approver),
        );
        let answer = executor
            .execute(
                "hub_exec".into(),
                json!({"program": "cmd", "args": ["/c", "echo", "sidecar-ok"]}),
            )
            .await
            .expect("exec answer");
        let text = answer.content[0]["text"].as_str().unwrap();
        assert!(text.contains("sidecar-ok"), "{text}");
        assert!(text.contains("\"exitCode\":0"), "{text}");
    }

    #[tokio::test]
    async fn failed_command_returns_diagnostics_as_a_tool_error() {
        let (_guard, root) = seeded_workspace();
        let (approver, seen) = recording_approver(true);
        let executor = hub_executor(
            root,
            true,
            HubToolCaps {
                exec: true,
                ..HubToolCaps::default()
            },
            Some(approver),
        );
        let error = executor
            .execute(
                "hub_exec".into(),
                json!({
                    "program": "cmd", "args": ["/c", "echo expected-42-actual-41 & exit /b 7"]
                }),
            )
            .await
            .unwrap_err();
        assert!(error.starts_with("command_failed: "), "{error}");
        let report: Value =
            serde_json::from_str(error.strip_prefix("command_failed: ").unwrap()).unwrap();
        assert_eq!(report["exitCode"], 7);
        assert!(report["stdout"]
            .as_str()
            .unwrap()
            .contains("expected-42-actual-41"));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// `hub_test` is environment-gated like exec/http: off →
    /// `test_not_permitted`, on without an approver → `approval_required`,
    /// denied → `approval_denied`, and the session write grant does not
    /// cover it.
    #[tokio::test]
    async fn hub_test_is_capability_gated_and_always_approved() {
        let (_guard, root) = seeded_workspace();
        let caps = HubToolCaps {
            test: true,
            ..HubToolCaps::default()
        };
        let args = json!({"path": "python", "content": "print(1)", "summary": "check"});

        // No approver at all — even under the write grant it fails closed.
        let executor = hub_executor(root.clone(), true, caps, None);
        assert_eq!(
            executor
                .execute("hub_test".into(), args.clone())
                .await
                .unwrap_err(),
            "approval_required"
        );

        // A denying approver sees the proposal once and nothing runs.
        let (approver, seen) = recording_approver(false);
        let executor = hub_executor(root.clone(), true, caps, Some(approver));
        assert_eq!(
            executor
                .execute("hub_test".into(), args.clone())
                .await
                .unwrap_err(),
            "approval_denied"
        );
        assert_eq!(
            seen.lock().unwrap()[0].summary,
            format!(
                "test {} — check",
                json!({
                    "language":"python", "content":"print(1)", "timeoutMs":30_000
                })
            )
        );

        // Cap off → refused before parsing, never reaching the approver.
        let (approver, seen) = recording_approver(true);
        let executor = hub_executor(root, false, HubToolCaps::default(), Some(approver));
        assert_eq!(
            executor.execute("hub_test".into(), args).await.unwrap_err(),
            "test_not_permitted"
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    /// Approved `hub_test` reaches the pinned Docker harness when it is
    /// available; without Docker the call fails `docker_unavailable` — either
    /// way the approval happened first and the workspace was snapshotted.
    #[tokio::test]
    async fn hub_test_runs_in_the_docker_snapshot_when_available() {
        let (_guard, root) = seeded_workspace();
        let (approver, seen) = recording_approver(true);
        let executor = hub_executor(
            root.clone(),
            false,
            HubToolCaps {
                test: true,
                ..HubToolCaps::default()
            },
            Some(approver),
        );
        // The snapshot needs an observed file first.
        executor
            .execute("hub_read".into(), json!({"path": "a.txt"}))
            .await
            .expect("read");
        let outcome = executor
            .execute(
                "hub_test".into(),
                json!({"path": "python", "content": "print('ok')", "summary": ""}),
            )
            .await;
        assert_eq!(seen.lock().unwrap().len(), 1);
        if crate::docker::isolation_available().await {
            let answer = outcome.expect("test answer");
            let text = answer.content[0]["text"].as_str().unwrap();
            assert!(text.contains("\"exitCode\":0"), "{text}");
            assert!(text.contains("observed_files_only"), "{text}");
        } else {
            // 隔離が使えない理由は2つある: デーモン不在（docker_unavailable）と
            // 固定イメージ未設定・未pull（pinned_image_unavailable）。どちらも閉じて失敗する。
            assert!(
                matches!(
                    outcome.unwrap_err().as_str(),
                    "docker_unavailable" | "pinned_image_unavailable"
                ),
                "unexpected error"
            );
        }
    }

    /// `hub_pay` has no capability flag and no session grant: malformed
    /// proposals fail before a human is asked, every call parks on the
    /// approver, deny answers `approval_denied`, and approval returns the
    /// decision's outcome — the paired panel's order result — as the tool
    /// answer. The desktop itself never moves funds.
    #[tokio::test]
    async fn hub_pay_always_asks_and_returns_the_hub_outcome() {
        let (_guard, root) = seeded_workspace();
        let product_id = uuid::Uuid::new_v4().to_string();
        let args = json!({"productId": product_id, "quantity": 2, "note": "restock"});

        // Malformed proposals never reach the approver.
        let (approver, seen) = recording_approver(true);
        let executor = hub_executor(root.clone(), true, HubToolCaps::default(), Some(approver));
        assert_eq!(
            executor
                .execute("hub_pay".into(), json!({"productId": "not-a-uuid"}))
                .await
                .unwrap_err(),
            "product_id_invalid"
        );
        assert!(seen.lock().unwrap().is_empty());

        // No approver at all — even under the write grant it fails closed.
        let executor = hub_executor(root.clone(), true, HubToolCaps::default(), None);
        assert_eq!(
            executor
                .execute("hub_pay".into(), args.clone())
                .await
                .unwrap_err(),
            "approval_required"
        );

        // Denied.
        let (approver, seen) = recording_approver(false);
        let executor = hub_executor(root.clone(), false, HubToolCaps::default(), Some(approver));
        assert_eq!(
            executor
                .execute("hub_pay".into(), args.clone())
                .await
                .unwrap_err(),
            "approval_denied"
        );
        assert_eq!(seen.lock().unwrap()[0].tool, "hub_pay");

        // Approved — the panel's order outcome becomes the tool result.
        let approver: PiApprover = Arc::new(|request: PiApprovalRequest| {
            Box::pin(async move {
                PiDecision {
                    approved: true,
                    outcome: Some(json!({
                        "ok": true,
                        "orderId": "ord_1",
                        "productId": request.detail["productId"].clone(),
                    })),
                }
            })
        });
        let executor = hub_executor(root.clone(), false, HubToolCaps::default(), Some(approver));
        let answer = executor
            .execute("hub_pay".into(), args)
            .await
            .expect("pay answer");
        assert_eq!(answer.details["orderId"], "ord_1");
        assert_eq!(answer.details["productId"], json!(product_id));
    }
    /// The market tools are read-only: no approval, no write grant. Malformed
    /// arguments are rejected before any network call.
    #[tokio::test]
    async fn market_tools_route_and_validate_without_approval() {
        let (_guard, root) = seeded_workspace();
        let executor = hub_executor(root, false, HubToolCaps::default(), None);
        for (tool, args, code) in [
            ("hub_catalog_search", json!({"query": ""}), "query_invalid"),
            ("hub_catalog_search", json!({"query": "x", "limit": 99}), "limit_invalid"),
            ("hub_product_read", json!({"productId": "item-1"}), "product_id_invalid"),
            ("hub_product_read", json!({}), "product_id_required"),
        ] {
            assert_eq!(executor.execute(tool.into(), args).await.unwrap_err(), code, "{tool}");
        }
    }
    #[tokio::test]
    async fn hub_pay_rejects_approval_without_an_execution_result() {
        let (_guard, root) = seeded_workspace();
        let args = json!({"productId": uuid::Uuid::new_v4().to_string(), "quantity": 1});
        for outcome in [None, Some(Value::Null)] {
            let approver: PiApprover = Arc::new(move |_| {
                let outcome = outcome.clone();
                Box::pin(async move { PiDecision { approved: true, outcome } })
            });
            let executor = hub_executor(root.clone(), true, HubToolCaps::default(), Some(approver));
            assert_eq!(executor.execute("hub_pay".into(), args.clone()).await.unwrap_err(), "purchase_outcome_missing");
        }
    }

    #[test]
    fn approval_summary_preserves_full_test_content_and_stated_intent() {
        let content = format!(
            "{}\n\r\t\u{0}\"\\末尾",
            "🧪".repeat((agent_tools::MAX_FILE_BYTES - 13) / 4)
        );
        let action = Action::parse(json!({
            "kind":"test", "path":"python", "content":content, "summary":"stated intent"
        }))
        .unwrap();
        let summary = approval_summary(&action);
        let encoded = summary
            .strip_prefix("test ")
            .unwrap()
            .strip_suffix(" — stated intent")
            .unwrap();
        let decoded: Value = serde_json::from_str(encoded).unwrap();
        assert_eq!(
            decoded,
            json!({"language":"python", "content":content, "timeoutMs":30_000})
        );
        assert!(summary.contains("末尾"));
        assert!(!encoded.contains(['\n', '\r', '\t', '\0']));
    }

    #[test]
    fn approval_summary_distinguishes_test_content_and_empty_content() {
        let make = |content: &str| {
            Action::parse(json!({
                "kind":"test", "path":"javascript", "content":content, "summary":""
            }))
            .unwrap()
        };
        assert_ne!(
            approval_summary(&make("print(1)")),
            approval_summary(&make("print(2)"))
        );
        assert_eq!(
            approval_summary(&make("")),
            format!(
                "test {}",
                json!({
                    "language":"javascript", "content":"", "timeoutMs":30_000
                })
            )
        );
        let content = "x".repeat(agent_tools::MAX_FILE_BYTES);
        assert_eq!(
            approval_summary(&make(&content)),
            format!(
                "test {}",
                json!({
                    "language":"javascript", "content":content, "timeoutMs":30_000
                })
            )
        );
    }
    #[tokio::test]
    async fn structured_approval_details_preserve_operator_arguments_without_execution() {
        let seen=Arc::new(Mutex::new(Vec::new()));let capture=seen.clone();
        let approver:PiApprover=Arc::new(move |request| {
            capture.lock().unwrap().push(request);
            Box::pin(async {PiDecision {approved:false,outcome:None}})
        });
        let workspace=std::env::temp_dir();
        let caps=HubToolCaps{exec:true,http:true,test:true,native_fs:false};
        let exec=json!({"program":"not-executed","args":["","two words","line\nbreak"],
            "stdin":"input\n","timeoutMs":1});
        assert_eq!(run_operator_tool("hub_exec",exec.clone(),&workspace,caps,Some(approver.clone())).await.unwrap_err(),"approval_denied");
        let http=json!({"method":"POST","url":"https://example.com/a","headers":{"x-demo":"example"},"body":"body\n","timeoutMs":1});
        assert_eq!(run_operator_tool("hub_http",http,&workspace,caps,Some(approver.clone())).await.unwrap_err(),"approval_denied");
        let requests=seen.lock().unwrap();assert_eq!(requests.len(),2);
        assert_eq!(requests[0].detail,json!({"kind":"exec","program":"not-executed","args":["","two words","line\nbreak"],"cwd":"","stdin":"input\n","timeoutMs":1}));
        assert_eq!(requests[0].summary,crate::agent_exec::ExecRequest::parse(exec).unwrap().describe());
        assert_eq!(requests[1].detail,json!({"kind":"http","method":"POST","url":"https://example.com/a","headers":[["x-demo","example"]],"body":"body\n","timeoutMs":1}));
        drop(requests);
        assert_eq!(run_operator_tool("hub_exec",json!({}),&workspace,HubToolCaps::default(),Some(approver)).await.unwrap_err(),"exec_not_permitted");
        assert_eq!(seen.lock().unwrap().len(),2);
    }
    #[tokio::test]
    async fn structured_approval_details_preserve_test_program_without_running_docker() {
        let seen=Arc::new(Mutex::new(Vec::new()));let capture=seen.clone();
        let approver:PiApprover=Arc::new(move |request| {
            capture.lock().unwrap().push(request);
            Box::pin(async {PiDecision {approved:false,outcome:None}})
        });
        let workspace=std::env::temp_dir();let files=Arc::new(Mutex::new(Files::default()));
        let args=json!({"path":"javascript","content":"throw 'not executed';\n","summary":"intent"});
        assert_eq!(run_agent_tool(&workspace,&files,"hub_test",args,false,HubToolCaps{test:true,..Default::default()},Some(approver)).await.unwrap_err(),"approval_denied");
        let requests=seen.lock().unwrap();assert_eq!(requests.len(),1);
        assert_eq!(requests[0].detail,json!({"kind":"test","language":"javascript","content":"throw 'not executed';\n","timeoutMs":30_000}));
        assert_eq!(requests[0].summary,format!("test {} — intent",json!({"language":"javascript","content":"throw 'not executed';\n","timeoutMs":30_000})));
    }

}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SteerFailure {
    Unsupported,
    Unknown,
    Rejected(&'static str),
}
#[derive(Clone)]
pub(crate) struct SteerAckRecord {
    pub result: Result<(), SteerFailure>,
    pub received_at_ms: u128,
}
#[derive(Default)]
struct SteerKnown {
    sent: bool,
    ack: Option<SteerAckRecord>,
}
#[derive(Clone)]
pub(crate) struct SidecarSteering {
    shared: Arc<SessionShared>,
    writer: mpsc::WeakSender<String>,
}
fn steer_ack(accepted: bool, code: Option<&str>) -> Result<(), SteerFailure> {
    if accepted {
        return if code.is_none() {
            Ok(())
        } else {
            Err(SteerFailure::Unknown)
        };
    }
    let code = match code {
        Some("steer_invalid_request") => "steer_invalid_request",
        Some("steer_id_conflict") => "steer_id_conflict",
        Some("steer_limit") => "steer_limit",
        Some("steer_not_ready") => "steer_not_ready",
        Some("steer_not_streaming") => "steer_not_streaming",
        Some("steer_stopped") => "steer_stopped",
        Some("steer_unsupported") => "steer_unsupported",
        Some("steer_failed") | None => "steer_failed",
        _ => return Err(SteerFailure::Unknown),
    };
    Err(SteerFailure::Rejected(code))
}
fn record_steer_ack(shared: &SessionShared, request_id: &str, accepted: bool, code: Option<&str>) {
    let result = steer_ack(accepted, code);
    let recorded = {
        let mut known = shared.steering_known.lock().unwrap();
        if let Some(entry) = known.get_mut(request_id) {
            if entry.ack.is_none() {
                entry.ack = Some(SteerAckRecord {
                    result: result.clone(),
                    received_at_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis(),
                });
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if recorded {
        if let Some(sender) = shared.steering.lock().unwrap().remove(request_id) {
            let _ = sender.send(result);
        }
    }
}
fn stop_steering(shared: &SessionShared) {
    shared
        .ending
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let pending = std::mem::take(&mut *shared.steering.lock().unwrap());
    for sender in pending.into_values() {
        let _ = sender.send(Err(SteerFailure::Unknown));
    }
}
struct SteerPending {
    shared: Arc<SessionShared>,
    request_id: String,
}
impl Drop for SteerPending {
    fn drop(&mut self) {
        self.shared
            .steering
            .lock()
            .unwrap()
            .remove(&self.request_id);
    }
}
impl SidecarSteering {
    pub(crate) fn stop(&self) {
        stop_steering(&self.shared);
    }
    pub(crate) fn known_ack(&self, request_id: &str) -> Option<SteerAckRecord> {
        self.shared
            .steering_known
            .lock()
            .unwrap()
            .get(request_id)
            .filter(|known| known.sent)
            .and_then(|known| known.ack.clone())
    }
    pub(crate) fn ready(&self) -> bool {
        !self.shared.ending.load(std::sync::atomic::Ordering::SeqCst)
            && self
                .shared
                .hello
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|hello| hello.supports_steering)
    }
    pub(crate) async fn send(
        &self,
        request_id: &str,
        text: &str,
        timeout: Duration,
    ) -> Result<(), SteerFailure> {
        if self.shared.ending.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(SteerFailure::Unknown);
        }
        if !self.ready() {
            return Err(SteerFailure::Unsupported);
        }
        let writer = self.writer.upgrade().ok_or(SteerFailure::Unknown)?;
        {
            let mut known = self.shared.steering_known.lock().unwrap();
            if known.len() >= 16 || known.contains_key(request_id) {
                return Err(SteerFailure::Unknown);
            }
            known.insert(request_id.to_owned(), SteerKnown::default());
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.shared.steering.lock().unwrap();
            if self.shared.ending.load(std::sync::atomic::Ordering::SeqCst)
                || pending.contains_key(request_id)
            {
                return Err(SteerFailure::Unknown);
            }
            pending.insert(request_id.to_owned(), tx);
        }
        let _pending = SteerPending {
            shared: Arc::clone(&self.shared),
            request_id: request_id.to_owned(),
        };
        let frame = encode(&HubFrame::Steer {
            request_id: request_id.to_owned(),
            text: text.to_owned(),
        });
        tokio::time::timeout(timeout, async {
            if self.shared.ending.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(SteerFailure::Unknown);
            }
            writer
                .send(frame)
                .await
                .map_err(|_| SteerFailure::Unknown)?;
            if let Some(known) = self
                .shared
                .steering_known
                .lock()
                .unwrap()
                .get_mut(request_id)
            {
                known.sent = true;
            }
            rx.await.map_err(|_| SteerFailure::Unknown)?
        })
        .await
        .map_err(|_| SteerFailure::Unknown)?
    }
}

#[cfg(test)]
impl SidecarSteering {
    pub(crate) fn test_sender(
        supports: bool,
    ) -> (Self, mpsc::Receiver<String>, mpsc::Sender<String>) {
        let shared = Arc::new(SessionShared::default());
        *shared.hello.lock().unwrap() = Some(HelloInfo {
            generation: None,
            supports_steering: supports,
            proto: 1,
            active_tools: Vec::new(),
            tools: Vec::new(),
            model: None,
            available: None,
        });
        let (writer, receiver) = mpsc::channel(32);
        (
            Self {
                shared,
                writer: writer.downgrade(),
            },
            receiver,
            writer,
        )
    }
    pub(crate) fn test_ack(&self, request_id: &str, accepted: bool, code: Option<&str>) {
        record_steer_ack(&self.shared, request_id, accepted, code);
    }
    pub(crate) fn test_capability(&self, supports: bool) {
        self.shared
            .hello
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .supports_steering = supports;
    }
}

#[cfg(test)]
mod steering_transport_tests {
    use super::*;
    const REQUEST: &str = "00000000-0000-4000-8000-000000000001";
    async fn wire() -> (
        TransportCore,
        SidecarSteering,
        tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
    ) {
        let (ours, theirs) = tokio::io::duplex(65536);
        let (rd, wr) = tokio::io::split(ours);
        let (out, input) = tokio::io::split(theirs);
        let executor: Arc<dyn ToolExecutor> =
            Arc::new(|_: String, _: Value| async { Ok(ToolAnswer::text("unused")) });
        let core = attach(
            rd,
            wr,
            SidecarHooks::new(executor),
            SidecarLimits {
                session: Duration::from_secs(2),
                tool_call: Duration::from_millis(50),
                drain: Duration::from_millis(20),
            },
        );
        let handle = SidecarSteering {
            shared: Arc::clone(&core.shared),
            writer: core.writer.downgrade(),
        };
        let mut input = input;
        input
            .write_all(b"{\"type\":\"hello\",\"proto\":1,\"supportsSteering\":true}\n")
            .await
            .unwrap();
        while !handle.ready() {
            tokio::task::yield_now().await;
        }
        (core, handle, BufReader::new(out).lines(), input)
    }
    #[tokio::test]
    async fn writer_success_is_not_ack_and_late_ack_is_readable_without_resend() {
        let (core, handle, mut output, mut input) = wire().await;
        let sent = handle.clone();
        let task = tokio::spawn(async move {
            sent.send(REQUEST, " literal \ntext ", Duration::from_millis(20))
                .await
        });
        let frame: Value =
            serde_json::from_str(&output.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(
            frame,
            json!({"type":"steer","requestId":REQUEST,"text":" literal \ntext "})
        );
        assert!(handle.known_ack(REQUEST).is_none());
        assert_eq!(task.await.unwrap(), Err(SteerFailure::Unknown));
        input
            .write_all(
                format!(
                    "{}\n",
                    json!({"type":"steer_ack","requestId":REQUEST,"accepted":true})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        while handle.known_ack(REQUEST).is_none() {
            tokio::task::yield_now().await;
        }
        assert!(handle.known_ack(REQUEST).unwrap().result.is_ok());
        assert_eq!(
            handle
                .send(REQUEST, " literal \ntext ", Duration::from_millis(20))
                .await,
            Err(SteerFailure::Unknown)
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), output.next_line())
                .await
                .is_err()
        );
        input
            .write_all(b"{\"type\":\"agent_done\",\"ok\":true}\n")
            .await
            .unwrap();
        drop(input);
        assert!(core.wait().await.unwrap());
    }
    #[tokio::test]
    async fn negative_ack_and_ending_wake_pending_requests_with_no_fake_success() {
        let (core, handle, mut output, mut input) = wire().await;
        let sent = handle.clone();
        let task =
            tokio::spawn(async move { sent.send(REQUEST, "text", Duration::from_secs(1)).await });
        output.next_line().await.unwrap();
        input.write_all(format!("{}\n",json!({"type":"steer_ack","requestId":REQUEST,"accepted":false,"code":"steer_not_streaming"})).as_bytes()).await.unwrap();
        assert_eq!(
            task.await.unwrap(),
            Err(SteerFailure::Rejected("steer_not_streaming"))
        );
        let request = "00000000-0000-4000-8000-000000000002";
        let sent = handle.clone();
        let task =
            tokio::spawn(async move { sent.send(request, "text", Duration::from_secs(1)).await });
        output.next_line().await.unwrap();
        input
            .write_all(b"{\"type\":\"agent_done\",\"ok\":true}\n")
            .await
            .unwrap();
        assert_eq!(task.await.unwrap(), Err(SteerFailure::Unknown));
        assert!(!handle.ready());
        assert!(handle.known_ack(request).is_none());
        drop(input);
        assert!(core.wait().await.unwrap());
    }
    #[test]
    fn old_capability_and_unsolicited_or_unknown_ack_cannot_become_accepted() {
        let legacy: SidecarFrame = serde_json::from_str(r#"{"type":"hello","proto":1}"#).unwrap();
        assert!(matches!(
            legacy,
            SidecarFrame::Hello {
                supports_steering: false,
                ..
            }
        ));
        let shared = SessionShared::default();
        record_steer_ack(&shared, REQUEST, true, None);
        assert!(shared.steering_known.lock().unwrap().is_empty());
        assert_eq!(
            steer_ack(true, Some("steer_failed")),
            Err(SteerFailure::Unknown)
        );
        assert_eq!(
            steer_ack(false, Some("private body/key")),
            Err(SteerFailure::Unknown)
        );
        assert_eq!(
            steer_ack(false, Some("steer_limit")),
            Err(SteerFailure::Rejected("steer_limit"))
        );
    }
}


#[cfg(test)]
mod comparison_generation_tests {
    use super::*;
    #[test]
    fn generation_profile_rejects_unknown_missing_duplicates_and_numeric_widths() {
        for reasoning in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
            let profile: GenerationProfile = serde_json::from_value(json!({"temperature":2,"maxTokens":8192,"reasoning":reasoning})).unwrap();
            assert!(profile.validate().is_ok());
        }
        for raw in [
            json!({"temperature":0,"maxTokens":1,"reasoning":"unknown"}),
            json!({"temperature":0,"maxTokens":1,"reasoning":"off","seed":1}),
            json!({"maxTokens":1,"reasoning":"off"}),
            json!({"temperature":0,"maxTokens":1}),
            json!({"temperature":-0.01,"maxTokens":1,"reasoning":"off"}),
            json!({"temperature":2.01,"maxTokens":1,"reasoning":"off"}),
            json!({"temperature":0,"maxTokens":0,"reasoning":"off"}),
            json!({"temperature":0,"maxTokens":8193,"reasoning":"off"}),
            json!({"temperature":0,"maxTokens":4294967296u64,"reasoning":"off"}),
            json!({"temperature":0,"maxTokens":1.5,"reasoning":"off"}),
            json!({"temperature":null,"maxTokens":1,"reasoning":"off"}),
        ] { assert!(serde_json::from_value::<GenerationProfile>(raw).is_err()); }
        assert!(serde_json::from_str::<GenerationProfile>(r#"{"temperature":0,"temperature":1,"maxTokens":1,"reasoning":"off"}"#).is_err());
        for temperature in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(GenerationProfile { temperature, max_tokens:1, reasoning:GenerationReasoning::Off }.validate().is_err());
        }
    }
    #[test]
    fn generation_session_frame_is_requested_and_normal_shape_is_unchanged() {
        let profile = GenerationProfile { temperature:0.5, max_tokens:123, reasoning:GenerationReasoning::Low };
        let old = json!({"type":"session","entries":[],"workspaceMap":null,"verification":null});
        assert_eq!(serde_json::from_str::<Value>(&session_frame(json!([]), Value::Null, None, None).unwrap()).unwrap(), old);
        let mut expected = old;
        expected["generation"] = serde_json::to_value(&profile).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&session_frame(json!([]), Value::Null, None, Some(profile.clone())).unwrap()).unwrap(), expected);
        let frame: SidecarFrame = serde_json::from_value(json!({"type":"hello","proto":1,"generation":profile})).unwrap();
        assert!(matches!(frame, SidecarFrame::Hello { generation:Some(_), .. }));
        let old: SidecarFrame = serde_json::from_value(json!({"type":"hello","proto":1})).unwrap();
        assert!(matches!(old, SidecarFrame::Hello { generation:None, .. }));
        assert!(session_frame(Value::Null, Value::Null, None,
            Some(GenerationProfile { temperature:f64::INFINITY, max_tokens:1, reasoning:GenerationReasoning::Off })).is_err());
    }
}
