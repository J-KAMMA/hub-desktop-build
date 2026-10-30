//! Pi sidecar execution mode: the pi SDK owns the agent loop, Hub owns tool
//! execution and permissions. It is the Hub-owned internal harness, beside
//! dev_cli's provider-owned connectors. Both share the `DevRuns`
//! workspace-lease table, so one directory still hosts at most one run at a
//! time.
//!
//! A run spawns `node <sidecar script>` in a chosen workspace; every tool the
//! sidecar invokes crosses stdio back into `agent_tools` under the session's
//! write grant. Without that grant, a mutating call parks as a `pendingActions`
//! entry until `pi_work_decide` resolves it — per-action approval instead of
//! refusal. `SidecarSession::wait` consumes the session, so one task owns
//! it and publishes `PiRunState` here; cancelling aborts that task, which
//! drops the session and lets `kill_on_drop` end the child.

use crate::{
    dev_cli::DevRuns,
    native_pi,
    pi_sidecar::{
        hub_executor_sharing_files, HubToolCaps, PiApprovalRequest, PiApprover, PiDecision, SessionEvent,
        SidecarHooks, SidecarLimits, SidecarSession, SidecarSpec, SidecarTool, SidecarSteering, SteerFailure,
    },
};
use crate::pi_changes::{PiChangeArchive, PiChangeSummary, PiFileDiff};
pub use crate::pi_sidecar::{GenerationProfile, GenerationReasoning};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};

/// `hello` normally lands within milliseconds of spawn; a slow sidecar gets a
/// short grace before `wait()` makes the accessors unreachable.
const HELLO_TICK: Duration = Duration::from_millis(50);
const HELLO_TICKS: u32 = 40;
/// A runaway sidecar can emit tool_call frames forever; keep a bounded record.
const MAX_TOOL_CALLS: usize = 256;
/// Pending approvals are promises a human can answer; bound the queue and
/// deny beyond it rather than let the model flood the window.
const MAX_PENDING_ACTIONS: usize = 64;
/// Streamed assistant text is live-typing display state, not a transcript:
/// the buffer keeps only the last ~8 KiB of chars.
const MAX_PARTIAL_OUTPUT_CHARS: usize = 8 * 1024;
/// A gated tool call parks on a human decision; the default 60s per-call
/// deadline would expire long before one, so approval mode raises just that
/// budget. Only used when `allow_write` is false — ungated runs keep the
/// default limits.
const APPROVAL_TOOL_CALL: Duration = Duration::from_secs(10 * 60);
/// Hub decides which model the sidecar runs, mirroring agents.json deciding
/// the executable for dev_cli runs. The caller may override; the shape is
/// validated like a dev_cli model name. `PI_WORK_MODEL` overrides this
/// default; qwen2.5:3b measures materially better answers than 1.5b for a
/// modest tok/s cost, and `warm_model` hides the cold load.
const DEFAULT_MODEL: &str = "ollama/qwen2.5:3b";
/// A prompt is one argv element, never a shell; the cap only bounds frame
/// size and run-record bloat.
const MAX_PROMPT_CHARS: usize = 8000;
/// Run history is a JSONL file, one `PiRunState` per line appended at the
/// terminal transition; past this many lines it is rewritten to the tail.
const HISTORY_CAP_LINES: usize = 400;
/// Lines the rewrite keeps — the newest entries are what `persistent`
/// restores, so the tail is all that matters.
const HISTORY_KEEP_LINES: usize = 200;
const MAX_CONTEXT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiContinuation {
    pub available: bool,
    pub resumed_from: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct PiCheckpoint {
    workspace: PathBuf,
    entries: serde_json::Value,
    #[serde(default)]
    run: Option<PiRunState>,
    #[serde(default, rename = "fileChanges")]
    file_changes: Option<PiChangeArchive>,
    /// Path -> SHA-256 of the run's full file observations (no content). A
    /// resumed run re-reads each path and treats it as read only while the
    /// current file still has that hash; it grants no permission.
    #[serde(default, rename = "readObservations", skip_serializing_if = "Option::is_none")]
    read_observations: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkEngine {
    /// The deleted standard engine (2026-10-18, owner-approved). Kept only so saved standard
    /// runs still deserialize for display (history, diffs, outcomes); it never starts or
    /// resumes (`standard_engine_retired`). `Default` reads records that predate the field.
    #[default]
    Pi,
    Dsh,
    /// Pi with its own native tools; every file and shell operation still runs
    /// through Hub (`agent_native.rs`, `hub_exec`). Resumable and image-capable
    /// since 2026-10-18; its checkpoint header carries `hubEngine: "thin"`.
    Thin,
    /// Type-B external engines (2026-10-19, owner-approved; `external_engine.rs`): OpenCode and
    /// the DeepSeek Harness CLI, jailed, with only Hub's tools over the bridge's MCP server.
    /// Their checkpoint header carries `hubEngine: "opencode"` / `"dsh-cli"`.
    Opencode,
    #[serde(rename = "dsh-cli")]
    DshCli,
}

impl WorkEngine {
    /// The engine for a start (2026-10-18, owner-approved: thin is the only engine for new work,
    /// script overrides and image prompts included). A resume with no engine keeps the saved run's
    /// engine, so resuming a saved standard run reaches `validate_engine` and is refused.
    pub(crate) fn for_start(requested: Option<WorkEngine>, saved: Option<WorkEngine>) -> WorkEngine {
        requested.or(saved).unwrap_or(WorkEngine::Thin)
    }

    /// The sidecar's `PI_WORK_ENGINE` value.
    pub(crate) fn env_value(self) -> &'static str {
        match self {
            WorkEngine::Pi => "pi",
            WorkEngine::Dsh => "dsh",
            WorkEngine::Thin => "thin",
            WorkEngine::Opencode => crate::external_engine::OPENCODE,
            WorkEngine::DshCli => crate::external_engine::DSH_CLI,
        }
    }

    pub(crate) fn external_kind(self) -> Option<crate::external_engine::Kind> {
        match self {
            WorkEngine::Opencode => Some(crate::external_engine::Kind::Opencode),
            WorkEngine::DshCli => Some(crate::external_engine::Kind::DshCli),
            _ => None,
        }
    }
}

fn context_engine(entries: &serde_json::Value) -> Option<WorkEngine> {
    let items = entries.as_array()?;
    if items.len() > 10000 || serde_json::to_vec(entries).ok()?.len() > MAX_CONTEXT_BYTES {
        return None;
    }
    let header = items.first()?;
    match header["type"].as_str()? {
        // The thin sidecar marks its header; an unknown marker is not resumable.
        "session" => match header.get("hubEngine") {
            None => Some(WorkEngine::Pi),
            Some(marker) if marker == "thin" => Some(WorkEngine::Thin),
            Some(marker) if marker == crate::external_engine::OPENCODE => Some(WorkEngine::Opencode),
            Some(marker) if marker == crate::external_engine::DSH_CLI => Some(WorkEngine::DshCli),
            Some(_) => None,
        },
        "dsh-session" if header["version"] == 1 => {
            let id = header["id"].as_str()?.strip_prefix("hub-")?;
            (!id.is_empty()
                && id.len() <= 80
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .then_some(WorkEngine::Dsh)
        }
        _ => None,
    }
}

#[cfg(test)]
fn valid_context(entries: &serde_json::Value) -> bool {
    context_engine(entries).is_some()
}

/// The `hello` handshake snapshot, kept for the window's tool surface display.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiHello {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<GenerationProfile>,
    #[serde(default)]
    pub supports_steering: bool,
    pub proto: u64,
    pub active_tools: Vec<String>,
    pub tools: Vec<SidecarTool>,
    /// The "provider/id" the sidecar actually resolved. Absent on bundles
    /// built before the field existed and on a resolution failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// On a resolution failure, the "provider/id" specs the registry
    /// offered — the machine's picker data, surfaced for diagnosis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<Vec<String>>,
}

/// One sidecar `tool_call` frame; `ok` settles once Hub answers it.
/// `detail` is the call's target (path, command line, URL) — audit metadata
/// shown locally and saved only in the encrypted conversation. Plain history
/// retains tool names and outcomes without targets, previews or response bodies.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiToolCall {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// A parsed mutation waiting on the operator; `pi_work_decide` resolves it
/// through the matching `decisions` channel. An entry is data, never
/// authority — it cannot apply anything itself.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPendingAction {
    pub id: String,
    pub tool: String,
    pub summary: String,
    /// Structured spec for tools whose approval executes outside the
    /// desktop — `hub_pay` carries the purchase spec so the paired panel can
    /// run the Hub-side order. Null for the workspace/exec/http tools.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub detail: serde_json::Value,
    pub proposed_at_ms: u128,
}

/// Final session state. `error` carries the transport failure when `wait`
/// itself failed rather than the agent reporting `ok: false`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiOutcome {
    pub ok: bool,
    /// True only when Hub itself ran the declared verification command and it
    /// passed. A model or subagent saying it ran or passed never sets this.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub verified: bool,
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Ollama drops a model ~5 minutes after its last use; a cold 7b reload cost
/// ~9.2s measured on this machine before the first token. Firing a bodiless
/// keep_alive request at run start overlaps that load with sidecar spawn and
/// keeps the model resident across closely spaced runs. Best-effort: the run
/// path is unchanged when the provider is not ollama or the request fails.
fn warm_model(model: &str) {
    let Some(model_id) = model.strip_prefix("ollama/") else {
        return;
    };
    let model_id = model_id.to_string();
    tokio::spawn(async move {
        let _ = reqwest::Client::new()
            .post("http://localhost:11434/api/generate")
            .json(&serde_json::json!({
                "model": model_id,
                "prompt": "",
                "stream": false,
                "keep_alive": "30m",
            }))
            .timeout(Duration::from_secs(30))
            .send()
            .await;
    });
}

/// Shared run record the window polls through `pi_work_status`/`pi_work_list`.
/// Also the history line shape: `Deserialize` exists for restore, not for
/// accepting states from callers.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRunState {
    #[serde(skip)]
    image_receipt_valid: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_attachments: Vec<crate::pi_images::ImageAttachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_context_refs: Vec<crate::pi_images::ImageReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prompt_image_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reattached_image_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<GenerationProfile>,
    #[serde(default)]
    pub supports_steering: bool,
    #[serde(default)]
    pub instructions: Vec<PiSteerInstruction>,
    #[serde(default)]
    pub changes: PiChangeSummary,
    #[serde(default)]
    pub verification: Option<crate::verification::VerificationState>,
    /// Id of the fast type/lint checker attached to edit results (`fast_check`), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_check: Option<String>,
    /// Present only on a best-of-N parent run (`pi_best_of.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best_of: Option<best_of::BestOfState>,
    #[serde(default)]
    pub engine: WorkEngine,
    #[serde(default)]
    pub usage: PiUsage,
    #[serde(default)]
    pub continuation: PiContinuation,
    /// Final assistant text is displayed locally and persisted only encrypted.
    #[serde(default)]
    pub final_output: String,
    pub id: String,
    pub workspace: String,
    pub script: String,
    pub model: String,
    pub prompt: String,
    pub allow_write: bool,
    /// Run-level opt-ins for the operator-only tools; each call still parks
    /// on an individual decision. `#[serde(default)]` keeps pre-flag history
    /// lines readable — restored runs are dead display data anyway.
    #[serde(default)]
    pub allow_exec: bool,
    #[serde(default)]
    pub allow_http: bool,
    /// The pinned Docker snapshot harness was reachable at start, so
    /// `hub_test` was advertised. Environment-gated, never an operator flag.
    #[serde(default)]
    pub allow_test: bool,
    /// "running" | "done" | "failed" | "cancelled".
    pub status: String,
    pub hello: Option<PiHello>,
    pub tool_calls: Vec<PiToolCall>,
    /// Mutations parked on an operator decision; emptied at terminal.
    pub pending_actions: Vec<PiPendingAction>,
    /// AgentEvent frames carry no per-kind progress here; the count is the
    /// observable "still working" signal.
    pub agent_events: u64,
    /// Live tail of the assistant's streamed text while the run is active;
    /// cleared at the terminal transition like `pending_actions`.
    /// `#[serde(default)]` keeps pre-field history lines readable.
    #[serde(default)]
    pub partial_output: String,
    pub outcome: Option<PiOutcome>,
    pub stderr_tail: String,
    pub started_at_ms: u128,
    pub ended_at_ms: Option<u128>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUsage {
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl PiUsage {
    fn observe(&mut self, event: &serde_json::Value) {
        let usage = if event["type"] == "compaction_usage" {
            &event["usage"]
        } else if event["type"] == "message_end" && event["message"]["role"] == "assistant" {
            &event["message"]["usage"]
        } else {
            return;
        };
        let values: Option<Vec<u64>> = ["input", "output", "cacheRead", "cacheWrite"]
            .iter()
            .map(|key| usage[*key].as_u64())
            .collect();
        if let Some(values) = values {
            self.requests = self.requests.saturating_add(1);
            self.input = self.input.saturating_add(values[0]);
            self.output = self.output.saturating_add(values[1]);
            self.cache_read = self.cache_read.saturating_add(values[2]);
            self.cache_write = self.cache_write.saturating_add(values[3]);
        }
    }
}

struct PiRun {
    steering: Option<SidecarSteering>,
    steering_checkpoint: Option<crate::checkpoint::CheckpointStore>,
    steering_ledger: Mutex<SteeringLedger>,
    steering_gate: tokio::sync::Mutex<()>,
    file_changes: Arc<Mutex<PiChangeArchive>>,
    state: Arc<Mutex<PiRunState>>,
    /// Canonical path; also the lease key in `DevRuns`.
    workspace: PathBuf,
    /// Live stderr buffer cloned before `wait()` consumes the session, so
    /// `snapshot` can read mid-run diagnostics, not just the startup tail.
    stderr: Arc<Mutex<VecDeque<String>>>,
    /// action id -> decision channel behind `pending_actions`. Shared with
    /// the executor's approver and the wait task; clearing it drops the
    /// senders so every waiting receiver errors — fail closed.
    decisions: Arc<Mutex<HashMap<String, oneshot::Sender<PiDecision>>>>,
    /// Owns `session.wait()`. Aborting it drops the session; the child was
    /// spawned with `kill_on_drop`, so that ends the process.
    wait: Mutex<Option<JoinHandle<()>>>,
    /// Shared with the wait task: whichever terminal transition lands first
    /// appends the single history line. Restored runs start `true` — they
    /// are already in the file and must never be written back.
    recorded: Arc<AtomicBool>,
    /// Version counter bumped on every state mutation. The `watch` endpoint
    /// long-polls on it, so the window sees changes when they happen rather
    /// than on a poll cadence; watch coalesces bursts into the latest.
    changes: watch::Sender<u64>,
}

/// Owns only the lease and claimed image metadata until the wait task takes over.
/// No image bytes or fabricated SDK conversation are recorded on initialization failure.
struct PiInitializationGuard {
    service: PiWorkService,
    leases: Arc<tokio::sync::Mutex<DevRuns>>,
    runtime: tokio::runtime::Handle,
    workspace: PathBuf,
    id: String,
    image_run: Option<Arc<PiRun>>,
    error: &'static str,
    armed: bool,
}

impl PiInitializationGuard {
    fn new(service: &PiWorkService, leases: &Arc<tokio::sync::Mutex<DevRuns>>,
        workspace: &Path, id: &str) -> Self {
        Self { service: service.clone(), leases: leases.clone(), runtime: tokio::runtime::Handle::current(),
            workspace: workspace.into(), id: id.into(), image_run: None,
            error: "pi_image_initialization_unknown", armed: true }
    }

    fn retain_images(&mut self, state: Arc<Mutex<PiRunState>>, file_changes: Arc<Mutex<PiChangeArchive>>,
        decisions: Arc<Mutex<HashMap<String, oneshot::Sender<PiDecision>>>>, changes: watch::Sender<u64>) {
        if state.lock().unwrap().image_context_refs.is_empty() { return; }
        self.image_run = Some(Arc::new(PiRun {
            steering: None, steering_checkpoint: None, steering_ledger: Mutex::default(),
            steering_gate: tokio::sync::Mutex::new(()), file_changes, state,
            workspace: self.workspace.clone(), stderr: Arc::new(Mutex::default()), decisions,
            wait: Mutex::new(None), recorded: Arc::new(AtomicBool::new(false)), changes,
        }));
    }

    fn failure(&mut self, error: String) -> String {
        self.error = "pi_image_initialization_failed";
        if self.image_run.is_some() { self.error.into() } else { error }
    }

    fn disarm(&mut self) { self.armed = false; }
}

impl Drop for PiInitializationGuard {
    fn drop(&mut self) {
        if !self.armed { return; }
        if let Some(run) = &self.image_run {
            let snapshot = {
                let mut state = run.state.lock().unwrap();
                state.status = "failed".into();
                state.ended_at_ms = Some(now_ms());
                state.supports_steering = false;
                state.continuation.available = false;
                state.continuation.error = Some(self.error.into());
                state.outcome = Some(PiOutcome { verified: false, ok: false, exit_code: None, error: Some(self.error.into()) });
                clear_transient(&mut state);
                state.clone()
            };
            run.decisions.lock().unwrap().clear();
            let inserted = {
                let mut inner = self.service.inner.lock().unwrap();
                if inner.runs.contains_key(&self.id) { false } else {
                    inner.order.push(self.id.clone()); inner.runs.insert(self.id.clone(), run.clone()); true
                }
            };
            if inserted {
                run.changes.send_modify(|version| *version += 1);
                self.service.record_terminal(&run.recorded, &snapshot);
            }
        }
        // A dropped async initializer cannot await. Defer only a contended lease lock;
        // release_work checks the exact owner, so another run can never be released.
        if let Ok(mut leases) = self.leases.try_lock() {
            leases.release_work(&self.workspace, &self.id);
        } else {
            let (leases, workspace, id) = (self.leases.clone(), self.workspace.clone(), self.id.clone());
            self.runtime.spawn(async move { leases.lock().await.release_work(&workspace, &id); });
        }
    }
}

/// Removes a pending action and its decision sender when the approval future
/// resolves OR is dropped (cancel, per-call timeout), so `pendingActions`
/// never shows an entry nobody can still answer.
struct PendingGuard {
    state: Arc<Mutex<PiRunState>>,
    decisions: Arc<Mutex<HashMap<String, oneshot::Sender<PiDecision>>>>,
    changes: watch::Sender<u64>,
    id: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.state
            .lock()
            .unwrap()
            .pending_actions
            .retain(|action| action.id != self.id);
        self.decisions.lock().unwrap().remove(&self.id);
        self.changes.send_modify(|version| *version += 1);
    }
}

/// Append one streamed delta, keeping only the tail. The cap counts chars,
/// not bytes — a multibyte tail is not allowed to under-fill the view.
fn push_partial(state: &mut PiRunState, text: &str) {
    state.partial_output.push_str(text);
    let excess = state
        .partial_output
        .chars()
        .count()
        .saturating_sub(MAX_PARTIAL_OUTPUT_CHARS);
    if excess > 0 {
        // The byte index of the first char to keep; it always exists
        // because excess < char count.
        let byte = state
            .partial_output
            .char_indices()
            .nth(excess)
            .map(|(index, _)| index)
            .unwrap_or_else(|| state.partial_output.len());
        state.partial_output.drain(..byte);
    }
}

/// What a terminal transition drops: parked approvals and the live tail —
/// both are in-flight display state, not part of the run record.
fn clear_transient(state: &mut PiRunState) {
    state.pending_actions.clear();
    state.partial_output.clear();
    if let Some(check) = &mut state.verification {
        if check.status == "running" {
            check.status = "incomplete".into();
        }
    }
}

fn final_text(event: &serde_json::Value) -> Option<String> {
    let message = &event["message"];
    if event["type"] != "message_end"
        || message["role"] != "assistant"
        || message["stopReason"] != "stop"
    {
        return None;
    }
    let mut chars = message["content"]
        .as_array()?
        .iter()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .flat_map(str::chars);
    let mut text: String = chars.by_ref().take(MAX_PARTIAL_OUTPUT_CHARS).collect();
    if chars.next().is_some() {
        text.push_str("\n[output truncated]");
    }
    Some(text)
}

/// Builds the executor's approval callback for a gated run. Each call mints
/// an action id, publishes a `pending_actions` entry, and parks a one-shot
/// decision channel `pi_work_decide` resolves. A terminal status, a full
/// queue, or a dropped sender all answer `false` — fail closed in every
/// direction, because the request is data, never authority.
fn approver_for(
    state: Arc<Mutex<PiRunState>>,
    decisions: Arc<Mutex<HashMap<String, oneshot::Sender<PiDecision>>>>,
    changes: watch::Sender<u64>,
) -> PiApprover {
    Arc::new(move |request: PiApprovalRequest| {
        let state = Arc::clone(&state);
        let decisions = Arc::clone(&decisions);
        let changes = changes.clone();
        Box::pin(async move {
            let denied = || PiDecision {
                approved: false,
                outcome: None,
            };
            let action_id = uuid::Uuid::new_v4().to_string();
            let (send, receive) = oneshot::channel();
            {
                // Push and register under the state lock so decide and the
                // terminal paths never see one half without the other.
                let mut state = state.lock().unwrap();
                if state.status != "running" || state.pending_actions.len() >= MAX_PENDING_ACTIONS {
                    return denied();
                }
                state.pending_actions.push(PiPendingAction {
                    id: action_id.clone(),
                    tool: request.tool,
                    summary: request.summary,
                    detail: request.detail,
                    proposed_at_ms: now_ms(),
                });
                decisions.lock().unwrap().insert(action_id.clone(), send);
                changes.send_modify(|version| *version += 1);
            }
            let _guard = PendingGuard {
                state,
                decisions,
                changes,
                id: action_id,
            };
            receive.await.unwrap_or_else(|_| denied())
        })
    })
}

#[derive(Default)]
struct Inner {
    runs: HashMap<String, Arc<PiRun>>,
    order: Vec<String>,
    /// Best-of-N parent id -> the attempt runs it started (`pi_best_of.rs`).
    children: HashMap<String, Vec<String>>,
}

/// Registry of live and finished sidecar sessions. Sessions are bound to
/// child processes, so a restart restores only the terminal states the
/// JSONL history kept — dead runs: data for the list, never authority.
/// `persistent` names the app-lifetime managed instance, mirroring
/// `WorkService`.
#[derive(Clone, Default)]
pub struct PiWorkService {
    queue: Arc<Mutex<queue_runtime::Runtime>>,
    #[cfg(test)]
    queue_fixture: Option<queue_runtime::TestFixture>,
    inner: Arc<Mutex<Inner>>,
    /// `%APPDATA%\jkamma-hub\pi-work-runs.jsonl` for the managed instance;
    /// `None` keeps tests and ephemeral services off the disk entirely.
    history: Option<PathBuf>,
    checkpoints: Option<crate::checkpoint::CheckpointStore>,
    /// Folder of the encrypted image attachments (`pi_images`); only removal uses it.
    images: Option<PathBuf>,
    model_probe: Arc<tokio::sync::Mutex<Option<CachedModelProbe>>>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

impl PiWorkService {
    pub fn persistent() -> Self {
        let service = Self {
            history: default_history(),
            checkpoints: crate::checkpoint::CheckpointStore::named("pi-sessions").ok(),
            images: crate::checkpoint::folder_path(crate::pi_images::FOLDER).ok(),
            ..Self::default()
        };
        // Old records go before they are read back, so an expired session never reappears.
        service.prune_expired();
        service.restore_history();
        service
    }

    /// Delete AI work sessions, their image attachments and history lines last
    /// written more than `RECORD_RETENTION` ago. Running work is never touched.
    pub(crate) fn prune_expired(&self) -> usize {
        let Some(cutoff) = std::time::SystemTime::now().checked_sub(RECORD_RETENTION) else { return 0 };
        self.prune_older_than(cutoff)
    }

    fn running_ids(&self) -> std::collections::HashSet<String> {
        let inner = self.inner.lock().unwrap();
        inner.runs.iter().filter(|(_, run)| run.state.lock().unwrap().status == "running").map(|(id, _)| id.clone()).collect()
    }

    /// Image ids that running work and the remaining saved sessions still use.
    fn referenced_images(&self, skip: &std::collections::HashSet<String>) -> std::collections::HashSet<String> {
        let mut used = std::collections::HashSet::new();
        {
            let inner = self.inner.lock().unwrap();
            for (id, run) in &inner.runs {
                if skip.contains(id) { continue; }
                used.extend(run.state.lock().unwrap().image_context_refs.iter().map(|image| image.id.clone()));
            }
        }
        if let Some(store) = &self.checkpoints {
            for (id, _) in crate::checkpoint::record_ids(store.directory()) {
                if skip.contains(&id) { continue; }
                if let Some(saved) = store.load::<PiCheckpoint>(&id) {
                    used.extend(saved_image_ids(&saved));
                }
            }
        }
        used
    }

    fn forget_runs(&self, ids: &std::collections::HashSet<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.order.retain(|id| !ids.contains(id));
        inner.runs.retain(|id, _| !ids.contains(id));
    }

    fn prune_older_than(&self, cutoff: std::time::SystemTime) -> usize {
        let running = self.running_ids();
        let cutoff_ms = cutoff.duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or_default();
        let mut removed: std::collections::HashSet<String> = self.checkpoints.as_ref()
            .map(|store| crate::checkpoint::remove_records_older_than(store.directory(), cutoff, &running))
            .unwrap_or_default().into_iter().collect();
        // Finished runs older than the cutoff also leave the list and the plaintext history.
        {
            let inner = self.inner.lock().unwrap();
            for (id, run) in &inner.runs {
                let state = run.state.lock().unwrap();
                if state.status != "running" && state.ended_at_ms.unwrap_or(state.started_at_ms) < cutoff_ms {
                    removed.insert(id.clone());
                }
            }
        }
        if let Some(path) = self.history.as_deref() {
            if let Some(gone) = rewrite_history(path, |state| {
                !running.contains(&state.id)
                    && (removed.contains(&state.id) || state.ended_at_ms.unwrap_or(state.started_at_ms) < cutoff_ms)
            }) { removed.extend(gone); }
        }
        if let Some(store) = &self.checkpoints {
            for id in &removed { store.remove(id); }
        }
        self.forget_runs(&removed);
        if let Some(images) = &self.images {
            let used = self.referenced_images(&removed);
            crate::checkpoint::remove_records_older_than(images, cutoff, &used);
        }
        removed.len()
    }

    /// Delete one finished work session: its encrypted conversation, its image
    /// attachments that no other session uses, and its history line.
    pub(crate) fn delete(&self, id: &str) -> Result<(), String> {
        if uuid::Uuid::parse_str(id).is_err() { return Err("pi_work_not_found".into()); }
        if self.running_ids().contains(id) { return Err("pi_work_still_running".into()); }
        let target: std::collections::HashSet<String> = [id.to_owned()].into();
        let mut own: std::collections::HashSet<String> = self.run(id)
            .map(|run| run.state.lock().unwrap().image_context_refs.iter().map(|image| image.id.clone()).collect())
            .unwrap_or_default();
        if let Some(saved) = self.checkpoints.as_ref().and_then(|store| store.load::<PiCheckpoint>(id)) {
            own.extend(saved_image_ids(&saved));
        }
        let used = self.referenced_images(&target);
        if let Some(path) = self.history.as_deref() {
            rewrite_history(path, |state| state.id == id).ok_or("pi_work_history_unavailable")?;
        }
        if let Some(store) = &self.checkpoints { store.remove(id); }
        if let Some(images) = &self.images {
            for image in own.difference(&used) { crate::checkpoint::remove_record(images, image); }
        }
        self.forget_runs(&target);
        Ok(())
    }

    /// Delete every finished work session and every image no running work uses.
    pub(crate) fn delete_all(&self) -> Result<usize, String> {
        let running = self.running_ids();
        let mut removed: std::collections::HashSet<String> = self.inner.lock().unwrap().runs.keys()
            .filter(|id| !running.contains(*id)).cloned().collect();
        if let Some(path) = self.history.as_deref() {
            removed.extend(rewrite_history(path, |state| !running.contains(&state.id)).ok_or("pi_work_history_unavailable")?);
        }
        if let Some(store) = &self.checkpoints {
            for (id, _) in crate::checkpoint::record_ids(store.directory()) {
                if !running.contains(&id) { store.remove(&id); removed.insert(id); }
            }
            let _ = std::fs::remove_dir_all(store.directory().join("unreadable"));
        }
        self.forget_runs(&removed);
        if let Some(images) = &self.images {
            let used = self.referenced_images(&removed);
            for (id, _) in crate::checkpoint::record_ids(images) {
                if !used.contains(&id) { crate::checkpoint::remove_record(images, &id); }
            }
            let _ = std::fs::remove_dir_all(images.join("unreadable"));
        }
        Ok(removed.len())
    }

    /// Reads the JSONL history back as dead runs — display data only: no
    /// wait handle, no decision channels, no lease, and `recorded` already
    /// set so a later cancel cannot write them back. Malformed lines are
    /// skipped: one bad edit must not forfeit the rest of the file.
    fn restore_history(&self) {
        // Only authenticated checkpoint metadata can authorize an owned image.
        // SDK headers are a separate resume proof; early failures can retain
        // valid preview metadata without inventing a resumable SDK session.
        fn valid_image_run(run: &PiRunState, state: &PiRunState, workspace: &Path) -> bool {
            let refs = &run.image_context_refs;
            let attachments = &run.image_attachments;
            let ids: std::collections::HashSet<_> = refs.iter().map(|image| image.id.as_str()).collect();
            let attachment_ids: std::collections::HashSet<_> = attachments.iter().map(|image| image.id.as_str()).collect();
            let selected = |values: &[String], max: usize| {
                values.len() <= max
                    && values.iter().collect::<std::collections::HashSet<_>>().len() == values.len()
                    && values.iter().all(|id| ids.contains(id.as_str()))
            };
            workspace.is_absolute()
                && workspace.to_str().is_some_and(|value| value.encode_utf16().count() <= 32767 && !value.contains('\0'))
                && run.id == state.id && run.engine == state.engine && matches!(state.engine, WorkEngine::Pi | WorkEngine::Thin)
                && run.model == state.model
                && non_verbatim(PathBuf::from(&run.workspace)) == non_verbatim(workspace.to_path_buf())
                && refs.len() <= 4 && refs.len() == ids.len() && attachment_ids == ids
                && attachments.len() == refs.len()
                && refs.iter().all(|image| image_request_uuid(&image.id)
                    && matches!(image.mime_type.as_str(), "image/png" | "image/jpeg")
                    && (1..=crate::image_validation::MAX_IMAGE_BYTES).contains(&image.size_bytes)
                    && image.sha256.len() == 64
                    && image.sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
                && attachments.iter().all(|image| !image.name.trim().is_empty()
                    && image.name.encode_utf16().count() <= 255
                    && !image.name.chars().any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
                    && refs.iter().any(|reference| reference.id == image.id
                        && reference.mime_type == image.mime_type && reference.size_bytes == image.size_bytes))
                && selected(&run.prompt_image_ids, 1) && selected(&run.reattached_image_ids, 4)
                && !run.reattached_image_ids.iter().any(|id| run.prompt_image_ids.contains(id))
                && match &run.image_request_id {
                    Some(id) => !run.prompt_image_ids.is_empty() && image_request_uuid(id),
                    None => run.prompt_image_ids.is_empty(),
                }
        }
        let mut contents = self
            .history
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default();
        let recorded: std::collections::HashSet<_> = contents
            .lines()
            .filter_map(|line| serde_json::from_str::<PiRunState>(line).ok())
            .map(|run| run.id)
            .collect();
        // A process crash may leave no terminal JSONL record. Recover only
        // display data and conversation from authenticated local checkpoints;
        // no process, lease, pending action or permission is restarted.
        for checkpoint in self
            .checkpoints
            .as_ref()
            .map(|store| store.load_all::<PiCheckpoint>())
            .unwrap_or_default()
        {
            let Some(mut run) = checkpoint.run else {
                continue;
            };
            if run.status != "running"
                || recorded.contains(&run.id)
                || context_engine(&checkpoint.entries) != Some(run.engine)
                    && !checkpoint.file_changes.as_ref().is_some_and(PiChangeArchive::validate)
            {
                continue;
            }
            run.status = "failed".into();
            run.ended_at_ms = Some(now_ms());
            run.outcome = Some(PiOutcome { verified: false,
                ok: false,
                exit_code: None,
                error: Some(if context_engine(&checkpoint.entries) == Some(run.engine) {
                    "pi_session_interrupted_saved_turn_available"
                } else { "pi_session_interrupted_changes_available" }.into()),
            });
            clear_transient(&mut run);
            if let Ok(line) = serde_json::to_string(&run) {
                contents.push('\n');
                contents.push_str(&line);
            }
        }
        let mut inner = self.inner.lock().unwrap();
        let mut malformed = 0usize;
        for line in contents.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(mut state) = serde_json::from_str::<PiRunState>(line) else {
                malformed += 1;
                continue;
            };
            // Only terminal states are recorded; a "running" line would be
            // a zombie with no process behind it.
            if !matches!(state.status.as_str(), "done" | "failed" | "cancelled") {
                malformed += 1;
                continue;
            }
            let saved = self
                .checkpoints
                .as_ref()
                .and_then(|store| store.load::<PiCheckpoint>(&state.id));
            state.continuation.available = saved
                .as_ref()
                .is_some_and(|saved| context_engine(&saved.entries) == Some(state.engine));
            state.final_output = saved.as_ref().and_then(|saved| saved.run.as_ref())
                .map(|run| run.final_output.clone()).unwrap_or_default();
            let saved_workspace = saved.as_ref().filter(|saved| non_verbatim(saved.workspace.clone()) == non_verbatim(PathBuf::from(&state.workspace)));
            // Never use public JSONL image fields as preview authority.
            let had_public_images = !state.image_attachments.is_empty() || !state.image_context_refs.is_empty()
                || !state.prompt_image_ids.is_empty() || !state.reattached_image_ids.is_empty()
                || state.image_request_id.is_some();
            state.image_attachments.clear();
            state.image_context_refs.clear();
            state.prompt_image_ids.clear();
            state.reattached_image_ids.clear();
            state.image_request_id = None;
            state.image_receipt_valid = false;
            let saved_images = saved_workspace.and_then(|saved| saved.run.as_ref().map(|run| (saved, run)));
            let image_context_present = had_public_images || saved.as_ref().is_some_and(|saved| {
                saved.entries.as_array().and_then(|items| items.first())
                    .and_then(|header| header.get("hubImageRefs"))
                    .is_some_and(|refs| !refs.as_array().is_some_and(Vec::is_empty))
                || saved.run.as_ref().is_some_and(|run| !run.image_context_refs.is_empty()
                    || !run.image_attachments.is_empty() || !run.prompt_image_ids.is_empty()
                    || !run.reattached_image_ids.is_empty() || run.image_request_id.is_some())
            });
            if image_context_present {
                let valid_metadata = saved_images.filter(|(saved, run)| valid_image_run(run, &state, &saved.workspace));
                if let Some((saved, run)) = valid_metadata {
                    state.image_attachments = run.image_attachments.clone();
                    state.image_context_refs = run.image_context_refs.clone();
                    state.prompt_image_ids = run.prompt_image_ids.clone();
                    state.reattached_image_ids = run.reattached_image_ids.clone();
                    state.image_request_id = run.image_request_id.clone();
                    state.continuation.available = matches!(state.engine, WorkEngine::Pi | WorkEngine::Thin)
                        && context_engine(&saved.entries) == Some(state.engine)
                        && context_image_refs(&saved.entries).is_ok_and(|refs| refs == run.image_context_refs);
                } else {
                    state.continuation.available = false;
                }
                if !state.continuation.available {
                    state.continuation.error = Some(if valid_metadata.is_some() {
                        "pi_image_checkpoint_incomplete"
                    } else { "pi_image_restore_invalid" }.into());
                }
            }
            // Saved standard runs stay viewable but never resume (2026-10-18, owner-approved).
            if state.engine == WorkEngine::Pi {
                state.continuation.available = false;
                state.continuation.error = Some(STANDARD_ENGINE_RETIRED.into());
            }
            state.prompt = saved_workspace.and_then(|saved| saved.run.as_ref())
                .filter(|run| run.id == state.id && run.engine == state.engine && run.model == state.model
                    && non_verbatim(PathBuf::from(&run.workspace)) == non_verbatim(PathBuf::from(&state.workspace)))
                .map(|run| run.prompt.clone()).unwrap_or_default();
            state.generation = saved_workspace.and_then(|saved| saved.run.as_ref()).and_then(|run| run.generation.clone());
            state.supports_steering = false;
            state.instructions = saved_workspace.and_then(|saved| saved.run.as_ref()).filter(|run| valid_restored_instructions(&run.instructions))
                .map(|run| run.instructions.clone()).unwrap_or_default();
            let workspace = saved_workspace.map(|saved| saved.workspace.clone()).unwrap_or_else(|| PathBuf::from(&state.workspace));
            let file_changes = saved_workspace.and_then(|saved| saved.file_changes.clone()).unwrap_or_default();
            state.changes = file_changes.summary();
            // A capped rewrite could repeat an id; the last line wins and
            // the order list must not hold the id twice.
            if inner.runs.contains_key(&state.id) {
                inner.order.retain(|entry| entry != &state.id);
            }
            let id = state.id.clone();
            // The deque is what `snapshot` reads for `stderr_tail`; seeding
            // it keeps the persisted tail visible the same way as a live run.
            let stderr: VecDeque<String> = state.stderr_tail.lines().map(str::to_owned).collect();
            let run = Arc::new(PiRun {
                steering: None, steering_checkpoint: None, steering_ledger: Mutex::new(SteeringLedger::default()), steering_gate: tokio::sync::Mutex::new(()), file_changes: Arc::new(Mutex::new(file_changes)),
                workspace,
                stderr: Arc::new(Mutex::new(stderr)),
                state: Arc::new(Mutex::new(state)),
                decisions: Arc::new(Mutex::new(HashMap::new())),
                wait: Mutex::new(None),
                recorded: Arc::new(AtomicBool::new(true)),
                // Dead runs never change; a placeholder channel keeps the
                // struct honest without watchers.
                changes: watch::channel(0).0,
            });
            inner.order.push(id.clone());
            inner.runs.insert(id, run);
        }
        drop(inner);
        if malformed > 0 {
            eprintln!("pi_work: skipped {malformed} malformed run-history lines");
        }
    }

    /// Tests inject the history path directly — an earlier APPDATA-mutating
    /// test raced and flaked unrelated cases, so no env lookup happens here.
    #[cfg(test)]
    fn with_history(path: PathBuf) -> Self {
        let service = Self {
            history: Some(path),
            ..Self::default()
        };
        service.restore_history();
        service
    }

    fn run(&self, id: &str) -> Option<Arc<PiRun>> {
        self.inner.lock().unwrap().runs.get(id).cloned()
    }

    fn snapshot(run: &PiRun) -> PiRunState {
        reconcile_steering(run);
        let mut state = run.state.lock().unwrap().clone();
        // `dev_cli::workspace()` spawns `git`; only a live thin run can be steerable, so ask for it only then.
        let may_steer = state.status == "running" && state.engine == WorkEngine::Thin;
        state.supports_steering = may_steer
            && steer_eligible(&state, &run.workspace, crate::dev_cli::workspace().as_ref())
            && run.steering.as_ref().is_some_and(SidecarSteering::ready);
        state.stderr_tail = run
            .stderr
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        state
    }

    /// The engine of a saved run a resume names (`None` without a resume or for an unknown id).
    pub(crate) fn saved_engine(&self, resume_id: Option<&str>) -> Option<WorkEngine> {
        resume_id.and_then(|id| self.status(id)).map(|run| run.engine)
    }

    pub fn status(&self, id: &str) -> Option<PiRunState> {
        self.run(id).as_deref().map(Self::snapshot)
    }

    pub fn diff(&self, run_id: &str, change_id: &str) -> Result<serde_json::Value, String> {
        if uuid::Uuid::parse_str(run_id).is_err() || uuid::Uuid::parse_str(change_id).is_err() {
            return Err("pi_change_not_found".into());
        }
        let run = self.run(run_id).ok_or("pi_work_not_found")?;
        let diff: PiFileDiff = run.file_changes.lock().map_err(|_| "pi_changes_unavailable")?
            .diff(&run.workspace, change_id)?;
        let mut value = serde_json::to_value(diff).map_err(|_| "pi_changes_unavailable")?;
        value.as_object_mut().ok_or("pi_changes_unavailable")?.insert("runId".into(), serde_json::json!(run_id));
        Ok(value)
    }

    fn resume_context(&self, id: &str, workspace: &Path) -> Result<serde_json::Value, String> {
        self.resume_checkpoint(id, workspace).map(|checkpoint| checkpoint.entries)
    }

    fn resume_checkpoint(&self, id: &str, workspace: &Path) -> Result<PiCheckpoint, String> {
        let run = self.status(id).ok_or("pi_work_not_found")?;
        if run.status == "running" {
            return Err("pi_work_still_running".into());
        }
        if run.engine == WorkEngine::Pi {
            return Err(STANDARD_ENGINE_RETIRED.into());
        }
        let checkpoint: PiCheckpoint = self
            .checkpoints
            .as_ref()
            .and_then(|store| store.load(id))
            .ok_or("pi_session_unavailable")?;
        if checkpoint.workspace != workspace {
            return Err("pi_session_workspace_mismatch".into());
        }
        let has_images = !run.image_context_refs.is_empty()
            || checkpoint.entries.as_array().and_then(|items| items.first())
                .is_some_and(|header| header.get("hubImageRefs").is_some())
            || run.continuation.error.as_deref().is_some_and(|error| error.starts_with("pi_image_"));
        if has_images && !run.continuation.available {
            return Err("pi_image_checkpoint_incomplete".into());
        }
        if context_engine(&checkpoint.entries) != Some(run.engine) {
            return Err("pi_session_invalid".into());
        }
        if context_image_refs(&checkpoint.entries)? != run.image_context_refs { return Err("pi_image_checkpoint_incomplete".into()); }
        Ok(checkpoint)
    }

    /// Long-poll read for the window: when the run's version still equals
    /// `since`, wait out `deadline` for the next mutation instead of making
    /// the caller spin. Always answers with the current version + snapshot —
    /// on a deadline hit the body is just unchanged. A `since` the run never
    /// had (a dead restored run's placeholder channel sits at 0) waits too,
    /// which is correct: dead runs only ever answer with themselves.
    pub(crate) async fn watch(
        &self,
        id: &str,
        since: Option<u64>,
        deadline: Duration,
    ) -> Option<(u64, PiRunState)> {
        let run = self.run(id)?;
        let mut rx = run.changes.subscribe();
        if since == Some(*rx.borrow_and_update()) {
            let _ = tokio::time::timeout(deadline, rx.changed()).await;
        }
        let version = *rx.borrow();
        Some((version, Self::snapshot(&run)))
    }

    /// Appends the terminal state to the JSONL history — once per run, via
    /// the `recorded` check-and-set the wait task and `cancel` share so a
    /// racing pair still writes a single line. Write failures are logged,
    /// never propagated: bookkeeping must not fail a run.
    fn record_terminal(&self, recorded: &AtomicBool, state: &PiRunState) {
        if state.status == "running" {
            return;
        }
        if recorded.swap(true, Ordering::SeqCst) {
            return;
        }
        // Serialize final checkpoint writes with file observers and conversation saves.
        let run = self.run(&state.id);
        if let Some(run) = &run { reconcile_steering(run); }
        let mut state_guard = run.as_ref().map(|run| run.state.lock().unwrap());
        let mut state = state.clone();
        if let Some(live) = state_guard.as_ref() { state.changes = live.changes.clone(); state.instructions = live.instructions.clone(); }
        if let Some(store) = &self.checkpoints {
            let result = (|| {
                let workspace = run.as_ref().map(|run| run.workspace.clone()).unwrap_or_else(|| PathBuf::from(&state.workspace));
                let mut saved = store.load_optional_bounded::<PiCheckpoint>(&state.id, 16 * 1024 * 1024)?
                    .unwrap_or(PiCheckpoint { file_changes: None, read_observations: None, workspace: workspace.clone(), entries: serde_json::Value::Null, run: None });
                if saved.workspace != workspace { return Err("pi_session_workspace_mismatch".into()); }
                if let Some(run) = &run { saved.file_changes = Some(run.file_changes.lock().unwrap().clone()); }
                saved.run = Some(state.clone());
                store.save(&state.id, &saved)
            })();
            if let Err(error) = result {
                if let Some(run) = &run {
                    let mut archive = run.file_changes.lock().unwrap(); archive.mark_incomplete("save_failed");
                    state.changes = archive.summary();
                    if let Some(live) = state_guard.as_mut() { live.changes = state.changes.clone(); }
                    run.changes.send_modify(|version| *version += 1);
                }
                eprintln!("pi_work: failed to finalize session checkpoint: {error}");
            }
        }
        let Some(path) = self.history.as_deref() else {
            return;
        };
        if let Err(error) = append_history(path, &state) {
            eprintln!("pi_work: failed to write run history: {error}");
        }
    }

    pub fn list(&self) -> Vec<PiRunState> {
        let inner = self.inner.lock().unwrap();
        inner
            .order
            .iter()
            .filter_map(|id| inner.runs.get(id))
            .map(|run| Self::snapshot(run))
            .collect()
    }

    /// `GET /pi-work/models`: the picker's options — what the sidecar's
    /// ModelRuntime can actually resolve (builtin providers plus the user's
    /// `~/.pi/agent/models.json`), flattened to "provider/id" specs, plus
    /// `ready`, the subset whose provider auth resolves right now, plus the
    /// default a bare start would run. Cache a successful probe for ten seconds,
    /// invalidating on local config/auth/bundle metadata changes or refresh. The
    /// user's models.json is merged in too. A missing registry or failed
    /// probe is not an error — it just means an empty list and the panel
    /// falls back to a free-text field, so this always answers.
    pub(crate) async fn models(&self) -> serde_json::Value {
        self.models_with_refresh(false).await
    }

    pub(crate) async fn models_with_refresh(&self, refresh: bool) -> serde_json::Value {
        let mut cache = self.model_probe.lock().await;
        let stamp = model_probe_stamp();
        let probed = if !refresh
            && cache.as_ref().is_some_and(|cached| {
                cached.stamp == stamp && cached.at.elapsed() < Duration::from_secs(10)
            }) {
            cache.as_ref().map(|cached| cached.probe.clone())
        } else {
            let probe = probe_models_registry().await;
            *cache = probe
                .as_ref()
                .filter(|_| stamp == model_probe_stamp())
                .map(|probe| CachedModelProbe {
                    stamp,
                    at: std::time::Instant::now(),
                    probe: probe.clone(),
                });
            probe
        };
        drop(cache);
        let registry = match models_registry_path() {
            Some(path) => tokio::task::spawn_blocking(move || {
                std::fs::read_to_string(path)
                    .ok()
                    .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            })
            .await
            .ok()
            .flatten(),
            None => None,
        };
        let mut models = probed
            .as_ref()
            .map(|probe| probe.models.clone())
            .unwrap_or_default();
        models.extend(registry.as_ref().map(flatten_models).unwrap_or_default());
        models.sort();
        models.dedup();
        let mut body = serde_json::json!({
            "models": models,
            "default": default_model(),
            "locations": probed.as_ref().map(|probe| &probe.locations),
        });
        // Absent (not empty) means "auth state unknown" — the picker shows
        // no hints rather than falsely marking everything unusable.
        if let Some(ready) = probed.and_then(|probe| probe.ready) {
            body["ready"] = serde_json::json!(ready);
        }
        body
    }

    /// Reserve the workspace lease, spawn the sidecar, and hand the session
    /// to a wait task that publishes the outcome. The lease returns on every
    /// exit path — spawn failure, normal end, and cancel.
    #[cfg(test)]
    pub(crate) async fn start(
        &self,
        spec: SidecarSpec,
        model: String,
        prompt: String,
        allow_write: bool,
        allow_exec: bool,
        allow_http: bool,
        allow_test: bool,
        leases: &Arc<tokio::sync::Mutex<DevRuns>>,
    ) -> Result<PiRunState, String> {
        self.start_with_resume(
            spec,
            model,
            prompt,
            allow_write,
            allow_exec,
            allow_http,
            allow_test,
            None,
            leases,
            None,
        )
        .await
    }

    async fn start_with_resume(
        &self,
        spec: SidecarSpec,
        model: String,
        prompt: String,
        allow_write: bool,
        allow_exec: bool,
        allow_http: bool,
        allow_test: bool,
        resume_id: Option<&str>,
        leases: &Arc<tokio::sync::Mutex<DevRuns>>,
        verification: Option<crate::verification::VerificationCommand>,
    ) -> Result<PiRunState, String> {
        self.start_core(spec, model, prompt, allow_write, allow_exec, allow_http,
            allow_test, resume_id, leases, verification, None).await
    }
    async fn start_core(
        &self,
        spec: SidecarSpec,
        model: String,
        prompt: String,
        allow_write: bool,
        allow_exec: bool,
        allow_http: bool,
        allow_test: bool,
        resume_id: Option<&str>,
        leases: &Arc<tokio::sync::Mutex<DevRuns>>,
        verification: Option<crate::verification::VerificationCommand>,
        generation: Option<GenerationProfile>,
    ) -> Result<PiRunState, String> {
        self.start_core_images(spec, model, prompt, allow_write, allow_exec, allow_http,
            allow_test, resume_id, leases, verification, generation, None ,None).await
    }
    async fn start_core_images(
        &self,
        spec: SidecarSpec,
        model: String,
        prompt: String,
        allow_write: bool,
        allow_exec: bool,
        allow_http: bool,
        allow_test: bool,
        resume_id: Option<&str>,
        leases: &Arc<tokio::sync::Mutex<DevRuns>>,
        verification: Option<crate::verification::VerificationCommand>,
        generation: Option<GenerationProfile>,
        image_context: Option<NativeImageContext>,
        queue_claim: Option<queue::Claim>,
    ) -> Result<PiRunState, String> {
        self.start_core_proxied(spec, model, prompt, allow_write, allow_exec, allow_http, allow_test, resume_id,
            leases, verification, generation, image_context, queue_claim, None, Vec::new(), None).await
    }

    /// `byok_proxy` is the run's "AIの接続" proxy. The wait task owns it, so it stops when the
    /// run ends or is cancelled; every early return before that drops it too.
    async fn start_core_proxied(
        &self,
        spec: SidecarSpec,
        model: String,
        prompt: String,
        allow_write: bool,
        allow_exec: bool,
        allow_http: bool,
        allow_test: bool,
        resume_id: Option<&str>,
        leases: &Arc<tokio::sync::Mutex<DevRuns>>,
        verification: Option<crate::verification::VerificationCommand>,
        generation: Option<GenerationProfile>,
        image_context: Option<NativeImageContext>,
        queue_claim: Option<queue::Claim>,
        byok_proxy: Option<crate::byok::pi::ProxyHandle>,
        checkers: Vec<crate::verification::VerificationCommand>,
        // External engines: the run's `engine-runs\<run>` folder, removed with the wait task.
        engine_run_dir: Option<crate::external_engine::RunDir>,
) -> Result<PiRunState, String> {
        let mut queue_guard = queue_runtime::StartGuard::new(self, queue_claim);
        queue_guard.validate()?;
        if let Some(command) = &verification {
            if !allow_exec {
                return Err("verification_requires_exec".into());
            }
            command.validate()?;
        }
        // Every launch path names its engine; the deleted standard engine (or none) never spawns.
        let engine = match spec.env.iter().find(|(key, _)| key == "PI_WORK_ENGINE").map(|(_, value)| value.as_str()) {
            Some("dsh") => WorkEngine::Dsh,
            Some("thin") => WorkEngine::Thin,
            Some(crate::external_engine::OPENCODE) => WorkEngine::Opencode,
            Some(crate::external_engine::DSH_CLI) => WorkEngine::DshCli,
            _ => return Err(STANDARD_ENGINE_RETIRED.into()),
        };
        // An external engine runs only through the bridge, inside its own run folder.
        if engine.external_kind().is_some() != engine_run_dir.is_some() {
            return Err("engine_run_dir_required".into());
        }
        let (entries, inherited_generation, resumed_observations) = match resume_id {
            Some(id) => {
                let checkpoint = self.resume_checkpoint(id, &spec.workspace)?;
                (checkpoint.entries, checkpoint.run.and_then(|run| run.generation), checkpoint.read_observations)
            }
            None => (serde_json::json!([]), None, None),
        };
        let generation = generation.or(inherited_generation);
        if let Some(profile) = &generation {
            profile.validate()?;
            validate_comparison_model(&model)?;
        }
        if resume_id.is_some() && context_engine(&entries) != Some(engine) {
            return Err("pi_session_engine_mismatch".into());
        }
        let managed_session = spec
            .env
            .iter()
            .any(|(key, value)| key == "PI_SIDECAR_SESSION" && value == "1");
        if (resume_id.is_some() || verification.is_some() || generation.is_some()) && !managed_session {
            return Err("pi_session_unsupported".into());
        }
        let mut image_refs = context_image_refs(&entries)?;
        if (!image_refs.is_empty() || image_context.as_ref().is_some_and(|ctx| ctx.request.is_some()))
            && (image_context.is_none() || engine != WorkEngine::Thin || !managed_session || self.checkpoints.is_none()) {
            return Err("pi_image_unavailable".into());
        }
        if image_context.as_ref().is_some_and(|ctx| ctx.request.is_some()) && image_refs.len() >= 4 { return Err("pi_image_limit".into()); }
        let mut image_attachments = Vec::new();
        let mut image_transfers = Vec::new();
        let mut prompt_image_ids = Vec::new();
        let mut image_request_id = None;
        if !image_refs.is_empty() || image_context.as_ref().is_some_and(|ctx| ctx.request.is_some()) {
            let capability = image_capability(&model).await?;
            if !capability.ready || !capability.supported { return Err("pi_image_model_unsupported".into()); }
            let context = image_context.as_ref().ok_or("pi_image_unavailable")?;
            for reference in &image_refs {
                let image = context.images.load(reference, &spec.workspace).map_err(str::to_owned)?;
                image_attachments.push(image.attachment()); image_transfers.push(image.into_transfer());
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let workspace = spec.workspace.clone();
        leases
            .lock()
            .await
            .reserve_work(&workspace, &id)
            .map_err(str::to_owned)?;
        let mut initialization = PiInitializationGuard::new(self, leases, &workspace, &id);

        if let Some(context) = &image_context {
            if let Some(request) = &context.request {
                if !image_request_uuid(&request.request_id) || crate::dev_cli::workspace().as_ref() != Some(&workspace) {
                    leases.lock().await.release_work(&workspace, &id); return Err("pi_image_scope_changed".into());
                }
                let image = match context.images.claim_and_save(&request.image_id, &request.context_id, &model, &workspace) {
                    Ok(image) => image,
                    Err(error) => { leases.lock().await.release_work(&workspace, &id); return Err(error.into()); }
                };
                image_refs.push(image.reference()); prompt_image_ids.push(request.image_id.clone());
                image_request_id = Some(request.request_id.clone()); image_attachments.push(image.attachment());
                image_transfers.push(image.into_transfer());
            }
        }
        let file_changes = Arc::new(Mutex::new(PiChangeArchive::new()));
        let state = Arc::new(Mutex::new(PiRunState {
            image_receipt_valid: image_refs.is_empty(), image_attachments, image_context_refs: image_refs.clone(), prompt_image_ids: prompt_image_ids.clone(), reattached_image_ids: Vec::new(), image_request_id,
            fast_check: None, best_of: None,
            generation: generation.clone(), supports_steering: false, instructions: Vec::new(), changes: PiChangeSummary::default(),
            verification: verification.as_ref().map(|_| Default::default()),
            engine,
            usage: PiUsage::default(),
            final_output: String::new(),
            continuation: PiContinuation {
                resumed_from: resume_id.map(str::to_owned),
                error: (managed_session && self.checkpoints.is_none())
                    .then(|| "pi_session_storage_unavailable".into()),
                ..PiContinuation::default()
            },
            id: id.clone(),
            // Display only: the lease key and tool executor keep the canonical
            // PathBuf; the window shouldn't see `\\?\` verbatim noise.
            workspace: non_verbatim(workspace.clone())
                .to_string_lossy()
                .into_owned(),
            // argv[0] is the sidecar script; model and prompt are separate
            // fields so the operator's text never bleeds into a path label.
            script: spec
                .args
                .first()
                .cloned()
                .unwrap_or_else(|| spec.program.to_string_lossy().into_owned()),
            model,
            prompt,
            allow_write,
            allow_exec,
            allow_http,
            allow_test,
            status: "running".into(),
            hello: None,
            tool_calls: Vec::new(),
            pending_actions: Vec::new(),
            agent_events: 0,
            partial_output: String::new(),
            outcome: None,
            stderr_tail: String::new(),
            started_at_ms: now_ms(),
            ended_at_ms: None,
        }));
        state.lock().unwrap().changes = file_changes.lock().unwrap().summary();
        let observed = Arc::clone(&state);
        // Shared with the approver and the run record: `pi_work_decide` sends
        // on it; cancel and the wait task clear it to fail pending calls.
        let decisions = Arc::new(Mutex::new(
            HashMap::<String, oneshot::Sender<PiDecision>>::new(),
        ));
        // Every mutation below bumps this; `watch` long-polls on the version.
        let (changes, _) = watch::channel(0u64);
        initialization.retain_images(state.clone(), file_changes.clone(), decisions.clone(), changes.clone());
        // hub_exec/hub_http/hub_test have no session grant, and hub_pay is
        // always advertised with no grant at all — so a live run always
        // carries an approver for parked operator decisions.
        let observer_state = state.clone();
        let observer_archive = file_changes.clone();
        let observer_store = self.checkpoints.clone();
        let observer_workspace = workspace.clone();
        let observer_changes = changes.clone();
        let mut run_files = crate::agent_tools::Files::with_change_observer(Arc::new(move |change| {
            let mut state = observer_state.lock().unwrap();
            let mut archive = observer_archive.lock().unwrap();
            archive.record(change);
            persist_changes(&observer_store, &observer_workspace, &mut state, &mut archive);
            observer_changes.send_modify(|version| *version += 1);
        }));
        // A resumed run counts an earlier full read only while Hub's own fresh
        // read of that file still matches the checkpointed hash. Thin keeps
        // hash-only records; a changed file needs a fresh native read first.
        if let Some(hashes) = &resumed_observations {
            let root = workspace.clone();
            let hashes = hashes.clone();
            run_files = tokio::task::spawn_blocking(move || {
                if engine == WorkEngine::Thin {
                    run_files.restore_native_reads(&root, &hashes);
                } else {
                    run_files.restore_observations(&root, &hashes);
                }
                run_files
            })
            .await
            .map_err(|_| "pi_session_restore_failed".to_owned())?;
        }
        let run_files = Arc::new(Mutex::new(run_files));
        let checkpoint_files = run_files.clone();
        let executor = hub_executor_sharing_files(
            workspace.clone(),
            allow_write,
            HubToolCaps {
                exec: allow_exec,
                http: allow_http,
                test: allow_test, native_fs: engine == WorkEngine::Thin
            },
            Some({
                let approver = approver_for(
                    Arc::clone(&state),
                    Arc::clone(&decisions),
                    changes.clone(),
                );
                // The operator's declaration of the command for this run is
                // its approval (capped); every other action still parks.
                match &verification {
                    Some(command) => crate::verification::declared_approver(approver, command.clone()),
                    None => approver,
                }
            }),
            run_files,
        );
        // Fast type/lint feedback: only an operator-allowed argv (a declared
        // checker or the verification command) and only with allowExec.
        let checker = if allow_exec {
            let allowed: Vec<_> = checkers.iter().cloned().chain(verification.iter().cloned()).collect();
            crate::fast_check::select(&workspace, &allowed)
        } else {
            None
        };
        let executor = match checker {
            Some(checker) => {
                state.lock().unwrap().fast_check = Some(checker.id.clone());
                crate::fast_check::wrap(executor, workspace.clone(), checker)
            }
            None => executor,
        };
        let executor = if let Some(command) = &verification {
            let observed = state.clone();
            let changes = changes.clone();
            crate::verification::gate(
                executor,
                command.clone(),
                Arc::new(move |report| {
                    let mut state = observed.lock().unwrap();
                    if state.status != "running" {
                        return;
                    }
                    state.verification = Some(report);
                    changes.send_modify(|version| *version += 1);
                }),
            )
        } else {
            executor
        };
        let event_archive = file_changes.clone();
        let event_store = self.checkpoints.clone();
        let event_workspace = workspace.clone();
        let observed_changes = changes.clone();
        let stderr_changes = changes.clone();
        let mut hooks = SidecarHooks::new(executor)
            .with_stderr_notify(Arc::new(move || {
                stderr_changes.send_modify(|version| *version += 1);
            }))
            .with_observer(Arc::new(move |event| {
                let mut state = observed.lock().unwrap();
                match event {
                    SessionEvent::Hello {
                        generation,
                        supports_steering,
                        proto,
                        active_tools,
                        model,
                        available,
                    } => {
                        // The observer sees only names; the wait task adds
                        // the tool descriptors from `session.hello()`.
                        let tools = state
                            .hello
                            .take()
                            .map(|hello| hello.tools)
                            .unwrap_or_default();
                        // A resolved spec confirms what actually runs;
                        // absent on older bundles and resolution failures.
                        if let Some(resolved) = &model {
                            state.model = resolved.clone();
                        }
                        state.hello = Some(PiHello {
                            generation,
                            supports_steering,
                            proto,
                            active_tools,
                            tools,
                            model,
                            available,
                        });
                    }
                    SessionEvent::AgentEvent(event) => {
                        state.agent_events += 1;
                        if event["type"] == "image_inputs" {
                            let ids = event["promptImageIds"].as_array().map(|items| items.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
                            let reattached = event["reattachedImageIds"].as_array().map(|items| items.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
                            if ids == state.prompt_image_ids && reattached.iter().all(|id| state.image_context_refs.iter().any(|image| &image.id == id)) {
                                state.image_receipt_valid = true; state.reattached_image_ids = reattached;
                            } else { state.continuation.error = Some("pi_image_invalid_receipt".into()); }
                        }
                        state.usage.observe(&event);
                        if event["type"] == "agent_start" {
                            state.final_output.clear();
                        }
                        if let Some(text) = final_text(&event) {
                            state.final_output = text;
                        }
                    }
                    SessionEvent::PartialOutput { text } => push_partial(&mut state, &text),
                    SessionEvent::ToolCallStarted { id, name, detail } => {
                        if name == "hub_exec" {
                            let mut archive = event_archive.lock().unwrap();
                            archive.note_command();
                            persist_changes(&event_store, &event_workspace, &mut state, &mut archive);
                        }
                        if state.tool_calls.len() >= MAX_TOOL_CALLS {
                            state.tool_calls.remove(0);
                        }
                        state.tool_calls.push(PiToolCall {
                            id,
                            name,
                            detail,
                            ok: None,
                            preview: None,
                        });
                    }
                    SessionEvent::ToolCallSettled { id, ok, preview } => {
                        if let Some(call) =
                            state.tool_calls.iter_mut().rev().find(|call| call.id == id)
                        {
                            call.ok = Some(ok);
                            call.preview = preview;
                        }
                    }
                }
                observed_changes.send_modify(|version| *version += 1);
            }));
        if managed_session {
            let store = self.checkpoints.clone();
            let checkpoint_state = state.clone();
            let checkpoint_changes = changes.clone();
            let checkpoint_workspace = workspace.clone();
            let checkpoint_id = id.clone();
            let checkpoint_archive = file_changes.clone();
            hooks.on_checkpoint = Some(Arc::new(move |entries| {
                // Taken before the state lock: a file write holds `Files` while
                // its change observer locks state, so never nest them the other way.
                let read_observations = checkpoint_files
                    .lock()
                    .map(|files| files.observation_hashes())
                    .unwrap_or_default();
                // Serialize checkpoint writes with terminal state transitions:
                // a late save must not revive a cancelled run on restart.
                let mut state = checkpoint_state.lock().unwrap();
                if state.status != "running" {
                    return;
                }
                let result = if context_engine(&entries) != Some(state.engine) {
                    Err("pi_session_context_limit".to_string())
                } else if context_image_refs(&entries).ok().as_ref() != Some(&state.image_context_refs) {
                    Err("pi_image_checkpoint_incomplete".to_owned())
                } else if let Some(store) = &store {
                    let mut run = state.clone();
                    clear_transient(&mut run);
                    store.save(
                        &checkpoint_id,
                        &PiCheckpoint {
                            file_changes: Some(checkpoint_archive.lock().unwrap().clone()),
                            read_observations: Some(read_observations),
                            workspace: checkpoint_workspace.clone(),
                            entries,
                            run: Some(run),
                        },
                    )
                } else {
                    Err("pi_session_storage_unavailable".to_string())
                };
                if result.is_ok() {
                    state.continuation.available = true;
                }
                if result.is_err() {
                    let mut archive = checkpoint_archive.lock().unwrap();
                    archive.mark_incomplete("save_failed"); state.changes = archive.summary();
                }
                state.continuation.error = result.err();
                checkpoint_changes.send_modify(|version| *version += 1);
            }));
            // Preserve the last completed turn even if the resumed run is
            // cancelled before it can produce a new checkpoint.
            if resume_id.is_some() {
                if let Some(save) = &hooks.on_checkpoint {
                    save(entries.clone());
                }
            }
        }
        // An approver always exists (hub_pay parks without any session grant),
        // so every run gets the raised per-call deadline for parked approvals.
        let limits = SidecarLimits {
            tool_call: APPROVAL_TOOL_CALL,
            ..SidecarLimits::default()
        };
        let workspace_map = if managed_session {
            let map_root = workspace.clone();
            tokio::task::spawn_blocking(move || crate::agent_discovery::project_map(&map_root))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_else(|| serde_json::json!({"files":[],"unavailable":true}))
        } else {
            serde_json::Value::Null
        };
        queue_guard.validate()?;
        queue_guard.spawning();
        let mut session = match SidecarSession::spawn_with_limits(spec, hooks, limits).await {
            Ok(session) => session,
            Err(error) => {
                return Err(initialization.failure(error.to_string()));
            }
        };
        if managed_session {
            if let Err(error) = session
                .initialize_with_images(
                    entries,
                    workspace_map,
                    verification.map(|command| command.value()),
                    generation,
                    &image_transfers,
                    &prompt_image_ids,
                )
                .await
            {
                return Err(initialization.failure(error.to_string()));
            }
        }
        let stderr = session.stderr_handle();
        let run = Arc::new(PiRun {
            steering: Some(session.steering_handle()),
            steering_checkpoint: self.checkpoints.clone(),
            steering_ledger: Mutex::new(SteeringLedger::default()),
            steering_gate: tokio::sync::Mutex::new(()),
            file_changes: file_changes.clone(),
            state: Arc::clone(&state),
            workspace: workspace.clone(),
            stderr,
            decisions: Arc::clone(&decisions),
            wait: Mutex::new(None),
            recorded: Arc::new(AtomicBool::new(false)),
            changes: changes.clone(),
        });
        // Register before the wait task can finish; keep cancel from observing
        // an unassigned wait handle during this synchronous handoff.
        let mut wait = run.wait.lock().unwrap();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.order.push(id.clone());
            inner.runs.insert(id.clone(), run.clone());
        }
        queue_guard.registered(&id)?;
        let session_done = wait_session(
            session,
            Arc::clone(&state),
            Arc::clone(&run.stderr),
            decisions,
            changes,
            workspace,
            id.clone(),
            Arc::clone(leases),
            self.clone(),
            Arc::clone(&run.recorded),
        );
        *wait = Some(tokio::spawn(async move {
            let _byok_proxy = byok_proxy;
            let _engine_run_dir = engine_run_dir;
            session_done.await
        }));
        drop(wait);
        initialization.disarm();
        let snapshot = state.lock().unwrap().clone();
        Ok(snapshot)
    }

    pub(crate) async fn cancel(
        &self,
        id: &str,
        leases: &Arc<tokio::sync::Mutex<DevRuns>>,
    ) -> Result<PiRunState, String> {
        let run = self.run(id).ok_or("pi_work_not_found")?;
        if let Some(steering) = &run.steering { steering.stop(); }
        // Aborting drops the wait future and the session inside it;
        // `kill_on_drop` then ends the child. Awaiting the handle returns only
        // after that teardown ran.
        let wait = run.wait.lock().unwrap().take();
        if let Some(wait) = wait {
            wait.abort();
            let _ = wait.await;
        }
        // Best-of-N: the orchestrator is stopped, so no attempt can start now;
        // stop every attempt it started, then drop their scratch copies.
        let children = self.inner.lock().unwrap().children.get(id).cloned();
        if let Some(children) = children {
            for child in children {
                let _ = Box::pin(self.cancel(&child, leases)).await;
            }
            best_of::remove_scratch(id).await;
        }
        let transitioned = {
            let mut state = run.state.lock().unwrap();
            let transitioned = state.status == "running";
            if transitioned {
                state.status = "cancelled".into();
                state.ended_at_ms = Some(now_ms());
                // A restored run keeps its serialized pendingActions for
                // display; only a live transition may drop them.
                clear_transient(&mut state);
            }
            transitioned
        };
        if transitioned {
            run.changes.send_modify(|version| *version += 1);
            self.record_terminal(&run.recorded, &Self::snapshot(&run));
        }
        // Terminal status already blocks new approvals; dropping the senders
        // fails every still-waiting receiver closed.
        run.decisions.lock().unwrap().clear();
        leases.lock().await.release_work(&run.workspace, id);
        let snapshot = Self::snapshot(&run);
        queue_runtime::after_terminal(self.clone(), leases.clone(), &snapshot);
        Ok(snapshot)
    }

    /// The bundled window may attach an outcome for `hub_pay` only, and only
    /// the honest handoff record for that exact proposal: it moves no funds
    /// and grants nothing. Any other outcome from the window is refused.
    pub(crate) fn decide_from_window(
        &self,
        id: &str,
        action_id: &str,
        approve: bool,
        outcome: Option<serde_json::Value>,
    ) -> Result<PiRunState, String> {
        if outcome.as_ref().is_some_and(|value| !value.is_null()) {
            let run = self.run(id).ok_or("pi_work_not_found")?;
            let detail = run.state.lock().unwrap().pending_actions.iter()
                .find(|action| action.id == action_id && action.tool == "hub_pay")
                .map(|action| action.detail.clone());
            let valid = approve && detail.is_some_and(|detail| {
                let proposed = (detail.get("productId"), detail.get("quantity"));
                outcome.as_ref().and_then(|value| value.as_object()).is_some_and(|map| {
                    map.len() == 3
                        && map.get("status").and_then(|v| v.as_str()) == Some("handed_to_checkout")
                        && proposed.0.is_some() && map.get("productId") == proposed.0
                        && proposed.1.is_some() && map.get("quantity") == proposed.1
                })
            });
            if !valid { return Err("purchase_outcome_invalid".into()); }
        }
        self.decide(id, action_id, approve, outcome)
    }

    /// Resolve one `pendingActions` entry. Removing the sender makes the
    /// decision single-use — a second call is `pi_action_not_found`. A send
    /// failure means the call already ended; either way the entry leaves the
    /// state, so the window never shows an action nobody can answer.
    pub(crate) fn decide(
        &self,
        id: &str,
        action_id: &str,
        approve: bool,
        outcome: Option<serde_json::Value>,
    ) -> Result<PiRunState, String> {
        let run = self.run(id).ok_or("pi_work_not_found")?;
        // Native Desktop cannot execute purchases. Keep the action pending for
        // denial or an actual paired-panel result; approval alone is not a result.
        if approve && !outcome.as_ref().is_some_and(|value| !value.is_null())
            && run.state.lock().unwrap().pending_actions.iter()
                .any(|action| action.id == action_id && action.tool == "hub_pay") {
            return Err("purchase_execution_unavailable".into());
        }
        // The outcome lands verbatim in the tool result forwarded to the
        // model — cap it so a paired caller cannot stuff a runaway payload
        // into the loop.
        if let Some(outcome) = &outcome {
            let size = serde_json::to_string(outcome)
                .map(|encoded| encoded.len())
                .unwrap_or(usize::MAX);
            if size > 16_384 {
                return Err("outcome_too_large".into());
            }
        }
        let sender = run
            .decisions
            .lock()
            .unwrap()
            .remove(action_id)
            .ok_or("pi_action_not_found")?;
        run.state
            .lock()
            .unwrap()
            .pending_actions
            .retain(|action| action.id != action_id);
        run.changes.send_modify(|version| *version += 1);
        let _ = sender.send(PiDecision {
            approved: approve,
            outcome,
        });
        Ok(Self::snapshot(&run))
    }
}

fn persist_changes(store: &Option<crate::checkpoint::CheckpointStore>, workspace: &Path,
    state: &mut PiRunState, archive: &mut PiChangeArchive) {
    state.changes = archive.summary();
    let result = (|| {
        let store = store.as_ref().ok_or("pi_session_storage_unavailable")?;
        let mut saved = store.load_optional_bounded::<PiCheckpoint>(&state.id, 16 * 1024 * 1024)?
            .unwrap_or(PiCheckpoint { workspace: workspace.to_path_buf(), entries: serde_json::Value::Null,
                run: None, file_changes: None, read_observations: None });
        if saved.workspace != workspace { return Err("pi_session_workspace_mismatch".into()); }
        saved.file_changes = Some(archive.clone());
        saved.run = Some(state.clone());
        store.save(&state.id, &saved)
    })();
    if result.is_err() { archive.mark_incomplete("save_failed"); state.changes = archive.summary(); }
}

/// Owns the session until the transport finishes. `wait()` consumes it, so
/// `hello` — reachable only through `&SidecarSession` — is copied into shared
/// state first; stderr keeps flowing through the shared drain handle. The
/// transport runs in its own task, so the hello grace delays nothing but the
/// result collection.
fn wait_session(
    session: SidecarSession,
    state: Arc<Mutex<PiRunState>>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    decisions: Arc<Mutex<HashMap<String, oneshot::Sender<PiDecision>>>>,
    changes: watch::Sender<u64>,
    workspace: PathBuf,
    id: String,
    leases: Arc<tokio::sync::Mutex<DevRuns>>,
    service: PiWorkService,
    recorded: Arc<AtomicBool>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
    for _ in 0..HELLO_TICKS {
        if session.hello().is_some() {
            break;
        }
        tokio::time::sleep(HELLO_TICK).await;
    }
    {
        let mut state = state.lock().unwrap();
        if let Some(hello) = session.hello() {
            if let Some(resolved) = &hello.model {
                state.model = resolved.clone();
            }
            state.hello = Some(PiHello {
                generation: hello.generation,
                supports_steering: hello.supports_steering,
                proto: hello.proto,
                active_tools: hello.active_tools,
                tools: hello.tools,
                model: hello.model,
                available: hello.available,
            });
            changes.send_modify(|version| *version += 1);
        }
    }
    let result = session.wait().await;
    let mut snapshot = {
        let mut state = state.lock().unwrap();
        state.ended_at_ms = Some(now_ms());
        clear_transient(&mut state);
        match result {
            Ok(outcome) => {
                let verified = state
                    .verification
                    .as_ref()
                    .is_none_or(|check| check.status == "passed");
                let images_verified = state.image_context_refs.is_empty() || state.image_receipt_valid;
                state.status = if outcome.ok && verified && images_verified {
                    "done".into()
                } else {
                    "failed".into()
                };
                state.outcome = Some(PiOutcome {
                    verified: outcome.ok && images_verified && state.verification.as_ref().is_some_and(|check| check.status == "passed"),
                    ok: outcome.ok && verified && images_verified,
                    exit_code: outcome.exit_code,
                    error: if !images_verified { Some("pi_image_invalid_receipt".into()) } else { (!verified).then(|| "required_verification_not_passed".into()) },
                });
            }
            Err(error) => {
                state.status = "failed".into();
                state.outcome = Some(PiOutcome { verified: false,
                    ok: false,
                    exit_code: None,
                    error: Some(error.to_string()),
                });
            }
        }
        state.clone()
    };
    changes.send_modify(|version| *version += 1);
    // The stored stderr_tail is never updated mid-run; the recorded line
    // carries the drained tail like `snapshot` produces for the window.
    snapshot.stderr_tail = stderr
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    // Before the next await, so an abort landing here (cancel) cannot skip
    // the write; the shared flag keeps it to one line either way.
    service.record_terminal(&recorded, &snapshot);
    // Terminal status already blocks new approvals; dropping the senders
    // fails every still-waiting receiver closed.
    decisions.lock().unwrap().clear();
    leases.lock().await.release_work(&workspace, &id);
    let finished = service.status(&id).unwrap_or(snapshot);
    queue_runtime::after_terminal(service, leases, &finished);
    })
}

/// Only real, existing directories bound a run; canonicalizing also keeps the
/// lease key consistent with `dev_cli::workspace`.
pub(crate) fn resolve_workspace(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim())
        .canonicalize()
        .map_err(|_| "workspace_not_found".to_string())?;
    if !path.is_dir() {
        return Err("workspace_not_found".into());
    }
    Ok(path)
}

/// Sidecar entry-point resolution, first hit wins: `PI_WORK_SIDECAR` (the
/// ops/test override), the repo-vendored copy (canonical for checkouts and
/// parallel CI sessions — `env!("CARGO_MANIFEST_DIR")` only resolves while
/// the crate builds out of the repo), then the installed app-data copy.
fn default_script() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PI_WORK_SIDECAR") {
        return Some(PathBuf::from(path));
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vendor")
        .join("pi-sidecar")
        .join("pi-sidecar.mjs");
    if repo.is_file() {
        return Some(repo);
    }
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(
        PathBuf::from(base)
            .join("jkamma-hub")
            .join("vendor")
            .join("pi-sidecar")
            .join("pi-sidecar.mjs"),
    )
}

/// The model a run uses when the caller names none: `PI_WORK_MODEL` when it
/// holds a well-formed name, else the built-in default. `GET
/// /pi-work/models` reports the same value as `default`.
fn default_model() -> String {
    crate::dev_cli::model_name(
        std::env::var("PI_WORK_MODEL").ok().as_deref(),
        DEFAULT_MODEL,
    )
}

/// Where pi keeps its model registry. `PI_CODING_AGENT_DIR` wins like the
/// SDK's own lookup; otherwise it is the user's home (`~/.pi/agent`) — not
/// app-data, since the file belongs to the pi install, not to Hub.
fn models_registry_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        return Some(PathBuf::from(dir).join("models.json"));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(
        PathBuf::from(home)
            .join(".pi")
            .join("agent")
            .join("models.json"),
    )
}

/// What the registry probe found: every resolvable spec, plus `ready` — the
/// subset whose provider auth resolves right now (None = the sidecar could
/// not tell, distinct from an empty list which means "none usable").
#[derive(Clone)]
struct ModelProbe {
    models: Vec<String>,
    ready: Option<Vec<String>>,
    locations: HashMap<String, String>,
}

type ModelProbeStamp = Vec<(PathBuf, Option<(u64, std::time::SystemTime)>)>;
struct CachedModelProbe {
    stamp: ModelProbeStamp,
    at: std::time::Instant,
    probe: ModelProbe,
}

fn model_probe_stamp() -> ModelProbeStamp {
    let mut paths: Vec<PathBuf> = resolve_script(None).into_iter().collect();
    if let Some(path) = models_registry_path() {
        if let Some(parent) = path.parent() {
            paths.extend(["auth.json", "models-store.json"].map(|name| parent.join(name)));
        }
        paths.push(path);
    }
    paths
        .into_iter()
        .map(|path| {
            let stamp = std::fs::metadata(&path)
                .ok()
                .and_then(|meta| meta.modified().ok().map(|modified| (meta.len(), modified)));
            (path, stamp)
        })
        .collect()
}

/// Ask the sidecar what it can resolve: `node pi-sidecar.mjs --list-models`
/// prints the full registry — builtin providers plus models.json entries —
/// as one `{"type":"models"}` frame and exits before any session work.
/// Returns None when the script or node is missing or the probe times out;
/// the caller then serves the models.json flatten alone.
async fn probe_models_registry() -> Option<ModelProbe> {
    let script = resolve_script(None).ok()?;
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        crate::local_cli::quiet_command("node")
            .arg(&script)
            .arg("--list-models")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if frame.get("type").and_then(|t| t.as_str()) != Some("models") {
            continue;
        }
        let collect = |key: &str| {
            frame.get(key).and_then(|m| m.as_array()).map(|items| {
                items
                    .iter()
                    .filter_map(|m| m.as_str().map(str::to_owned))
                    .collect::<Vec<String>>()
            })
        };
        let models = collect("models").unwrap_or_default();
        if !models.is_empty() {
            return Some(ModelProbe {
                models,
                ready: collect("ready"),
                locations: frame["locations"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(spec, location)| {
                        location
                            .as_str()
                            .filter(|value| matches!(*value, "local" | "api"))
                            .map(|value| (spec.clone(), value.to_owned()))
                    })
                    .collect(),
            });
        }
    }
    None
}

/// Every "provider/id" the registry knows, sorted so the picker is stable.
/// Entries missing a string id — or providers without a models array — drop
/// out rather than fail the whole list.
fn flatten_models(registry: &serde_json::Value) -> Vec<String> {
    let mut models: Vec<String> = registry
        .get("providers")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flat_map(|providers| providers.iter())
        .flat_map(|(provider, entry)| {
            entry
                .get("models")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|model| model.get("id").and_then(serde_json::Value::as_str))
                .map(move |id| format!("{provider}/{id}"))
        })
        .collect();
    models.sort();
    models.dedup();
    models
}

/// The run history sits in the same app-data dir as the vendored sidecar.
/// The directory is created lazily on the first terminal write, not here.
fn default_history() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(
        PathBuf::from(base)
            .join("jkamma-hub")
            .join("pi-work-runs.jsonl"),
    )
}

/// Appends one JSONL state line. Past `HISTORY_CAP_LINES` the file is
/// rewritten to the newest `HISTORY_KEEP_LINES` through a temp file +
/// rename so a crash cannot leave a torn history. Reading the file per
/// terminal event is bounded by that same cap, so the cost stays trivial.
fn history_metadata(state: &PiRunState) -> PiRunState {
    let mut metadata = state.clone();
    metadata.image_attachments.clear();
    metadata.image_context_refs.clear();
    metadata.prompt_image_ids.clear();
    metadata.reattached_image_ids.clear();
    metadata.image_request_id = None;
    metadata.prompt.clear();
    metadata.instructions.clear();
    metadata.final_output.clear();
    metadata.partial_output.clear();
    metadata.stderr_tail.clear();
    metadata.pending_actions.clear();
    if let Some(best_of) = &mut metadata.best_of { best_of.review_diff.clear(); }
    metadata.supports_steering = false;
    for call in &mut metadata.tool_calls { call.detail = None; call.preview = None; }
    if let Some(outcome) = &mut metadata.outcome {
        if outcome.error.is_some() { outcome.error = Some("pi_work_failed".into()); }
    }
    metadata
}

/// AI work sessions, their images and history lines are kept this long (decided 2026-10-18).
const RECORD_RETENTION: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// One writer at a time for the plaintext history: append and rewrite must not interleave.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

fn saved_image_ids(saved: &PiCheckpoint) -> Vec<String> {
    let mut ids: Vec<String> = saved.run.as_ref()
        .map(|run| run.image_context_refs.iter().map(|image| image.id.clone()).collect())
        .unwrap_or_default();
    if let Some(refs) = saved.entries.as_array().and_then(|items| items.first())
        .and_then(|header| header.get("hubImageRefs")).and_then(|refs| refs.as_array()) {
        ids.extend(refs.iter().filter_map(|image| image.get("id")?.as_str().map(str::to_owned)));
    }
    ids
}

/// Drop the history lines `remove` selects; unreadable lines are kept as they are.
/// Returns the removed ids, or None when the file exists but cannot be rewritten.
fn rewrite_history(path: &Path, remove: impl Fn(&PiRunState) -> bool) -> Option<Vec<String>> {
    let _serial = HISTORY_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let mut removed = Vec::new();
    let kept: Vec<&str> = existing.lines().filter(|line| {
        match serde_json::from_str::<PiRunState>(line) {
            Ok(state) if remove(&state) => { removed.push(state.id); false }
            _ => !line.trim().is_empty(),
        }
    }).collect();
    if removed.is_empty() { return Some(removed); }
    let tmp = path.with_extension("jsonl.tmp");
    let body = if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) };
    std::fs::write(&tmp, body).ok()?;
    std::fs::rename(&tmp, path).ok()?;
    Some(removed)
}

fn append_history(path: &Path, state: &PiRunState) -> Result<(), std::io::Error> {
    let _serial = HISTORY_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let metadata = history_metadata(state);
    let mut line = serde_json::to_string(&metadata)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    line.push('\n');
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let kept: Vec<&str> = existing
        .lines()
        .filter(|entry| !entry.trim().is_empty())
        .collect();
    if kept.len() < HISTORY_CAP_LINES {
        return std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(line.as_bytes()));
    }
    // Tail of the old file plus the new line comes to HISTORY_KEEP_LINES.
    let tail = kept[kept.len().saturating_sub(HISTORY_KEEP_LINES - 1)..].join("\n");
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, format!("{tail}\n{line}"))?;
    std::fs::rename(&tmp, path)
}

fn resolve_script(script: Option<&str>) -> Result<PathBuf, String> {
    let path = match script {
        Some(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
        _ => default_script().ok_or("sidecar_script_missing")?,
    };
    let path = path
        .canonicalize()
        .map_err(|_| "sidecar_script_missing".to_string())?;
    if !path.is_file() {
        return Err("sidecar_script_missing".into());
    }
    Ok(non_verbatim(path))
}

/// Canonicalization is still the existence/link check we want, but on Windows
/// it yields `\\?\` verbatim paths — which Node refuses as a script entry
/// point (`EISDIR` on `lstat 'C:'`). Strip the prefix for argv and the run
/// record; `\\?\UNC\` maps back to the `\\server` form.
#[cfg(windows)]
pub(crate) fn non_verbatim(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    let Some(rest) = raw.strip_prefix(r"\\?\") else {
        return path;
    };
    match rest.strip_prefix(r"UNC\") {
        Some(unc) => PathBuf::from(format!(r"\\{unc}")),
        None => PathBuf::from(rest),
    }
}

#[cfg(not(windows))]
pub(crate) fn non_verbatim(path: PathBuf) -> PathBuf {
    path
}

fn validate_comparison_model(model: &str) -> Result<(), String> {
    if !model.starts_with("ollama/") || model.len() <= "ollama/".len()
        || crate::dev_cli::model_name(Some(model), DEFAULT_MODEL) != model {
        return Err("pi_work_comparison_model_invalid".into());
    }
    Ok(())
}

fn validate_comparison(workspace: &Path, selected: Option<&Path>, prompt: &str,
    model: &str, generation: &GenerationProfile, confirmed: bool) -> Result<(), String> {
    if !confirmed { return Err("pi_work_comparison_confirmation_required".into()); }
    if selected != Some(workspace) { return Err("pi_work_comparison_workspace_changed".into()); }
    validate_comparison_model(model)?;
    if prompt.trim().is_empty() { return Err("prompt_empty".into()); }
    if prompt.chars().count() > MAX_PROMPT_CHARS { return Err("prompt_too_long".into()); }
    if prompt.contains('\0') { return Err("pi_work_comparison_invalid_request".into()); }
    generation.validate()
}

fn comparison_spec(workspace: PathBuf, script: PathBuf, prompt: &str,
    model: &str, engine: WorkEngine) -> SidecarSpec {
    SidecarSpec {
        program: PathBuf::from("node"),
        args: vec![script.to_string_lossy().into_owned(), model.to_owned(), prompt.to_owned()],
        workspace,
        env: vec![("PI_SIDECAR_CAPS".into(), "".into()), ("PI_SIDECAR_SESSION".into(), "1".into()),
            ("PI_WORK_ENGINE".into(), engine.env_value().into())],
    }
}

/// Explicit local-only comparison; normal DSH new-run gate remains closed.
pub(crate) async fn launch_comparison(service: &PiWorkService,
    leases: &Arc<tokio::sync::Mutex<DevRuns>>, workspace: PathBuf, prompt: &str,
    model: &str, engine: WorkEngine, generation: GenerationProfile, confirmed: bool,
    selected_workspace: Option<PathBuf>) -> Result<PiRunState, String> {
    validate_comparison(&workspace, selected_workspace.as_deref(), prompt, model, &generation, confirmed)?;
    // Comparison cannot replace the reviewed bundled runtime with a script or SDK stub.
    if ["PI_WORK_SIDECAR", "PI_POC_SCENARIO"].iter().any(|name| std::env::var_os(name).is_some()) {
        return Err("pi_work_comparison_unavailable".into());
    }
    let script = resolve_script(None)?;
    service.start_core(comparison_spec(workspace, script, prompt, model, engine),
        model.to_owned(), prompt.to_owned(), false, false, false, false,
        None, leases, None, Some(generation)).await
}

#[tauri::command]
pub async fn pi_work_compare_start(window: tauri::Webview, workspace: String, prompt: String,
    model: String, engine: WorkEngine, generation: GenerationProfile, confirmed: bool,
    service: tauri::State<'_, PiWorkService>, state: tauri::State<'_, Arc<crate::RunnerState>>)
    -> Result<PiRunState, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if window.label() != "main" || !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    let workspace = resolve_workspace(&workspace)?;
    launch_comparison(&service, &state.dev_runs, workspace, &prompt, &model,
        engine, generation, confirmed, crate::dev_cli::workspace()).await
}


/// The deleted standard engine (2026-10-18, owner-approved): no new run and no resume.
pub(crate) const STANDARD_ENGINE_RETIRED: &str = "standard_engine_retired";

fn validate_engine(engine: WorkEngine, resume_id: Option<&str>) -> Result<(), String> {
    if engine == WorkEngine::Pi {
        return Err(STANDARD_ENGINE_RETIRED.into());
    }
    if engine == WorkEngine::Dsh && resume_id.is_none() {
        return Err("legacy_engine_requires_resume".into());
    }
    Ok(())
}

/// The launch path the native command and the paired-HTTP route share.
///
/// The caller supplies a resolved workspace and never names the script over
/// HTTP — `script` stays a local-window argument so a pairing token cannot
/// turn this into `node <any file>`.
pub(crate) async fn launch(
    service: &PiWorkService,
    leases: &Arc<tokio::sync::Mutex<DevRuns>>,
    workspace: PathBuf,
    prompt: &str,
    model: Option<&str>,
    script: Option<&str>,
    allow_write: bool,
    allow_exec: bool,
    allow_http: bool,
    resume_id: Option<&str>,
    engine: WorkEngine,
    verification: Option<crate::verification::VerificationCommand>,
    checkers: Vec<crate::verification::VerificationCommand>,
    best_of: Option<best_of::BestOfRequest>,
) -> Result<PiRunState, String> {
    // The paired Hub panel is a browser surface: it cannot start a run on the owner's
    // API key. "AIの接続" for AI work is offered only in the desktop window.
    if model.is_some_and(crate::byok::pi::is_reference) {
        return Err("byok_remote_not_allowed".into());
    }
    if let Some(request) = best_of {
        validate_engine(engine, resume_id)?;
        if script.is_some() || resume_id.is_some() || engine != WorkEngine::Thin {
            return Err("best_of_unsupported".into());
        }
        return best_of::launch(service, leases, workspace, prompt, model, allow_exec, allow_http,
            verification, checkers, request, engine).await;
    }
    launch_inner(service, leases, workspace, prompt, model, script, allow_write, allow_exec,
        allow_http, resume_id, engine, verification, None, None, checkers).await
}
async fn launch_inner(
    service: &PiWorkService,
    leases: &Arc<tokio::sync::Mutex<DevRuns>>,
    workspace: PathBuf,
    prompt: &str,
    model: Option<&str>,
    script: Option<&str>,
    allow_write: bool,
    allow_exec: bool,
    allow_http: bool,
    resume_id: Option<&str>,
    engine: WorkEngine,
    verification: Option<crate::verification::VerificationCommand>,
    image_context: Option<NativeImageContext>,
    queue_claim: Option<queue::Claim>,
    checkers: Vec<crate::verification::VerificationCommand>,
) -> Result<PiRunState, String> {
    validate_engine(engine, resume_id)?;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt_empty".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("prompt_too_long".into());
    }
    if let Some(command) = &verification {
        if !allow_exec {
            return Err("verification_requires_exec".into());
        }
        command.validate()?;
    }
    // Caller's pick wins, then the operator's `PI_WORK_MODEL`, then the
    // built-in default — the same chain `default_model()` reports.
    let env_model = std::env::var("PI_WORK_MODEL").ok();
    let requested = model.or(env_model.as_deref());
    // "AIの接続": Rust resolves the connection, reads its key and starts this run's proxy now.
    // The sidecar gets only the proxy URL and a one-time token; the key stays in the proxy and
    // never reaches the engine, the run record, history or checkpoint.
    let connection = match requested {
        Some(reference) if crate::byok::pi::is_reference(reference) => Some(
            crate::byok::pi::resolve_installed(reference)
                .and_then(crate::byok::pi::start)
                .map_err(str::to_owned)?,
        ),
        _ => None,
    };
    let model = match &connection {
        Some(connection) => connection.reference.clone(),
        None => crate::dev_cli::model_name(requested, DEFAULT_MODEL),
    };
    let sidecar_model = connection.as_ref().map_or_else(|| model.clone(), |c| c.sidecar_model.clone());
    // External engines reach a model only through the run's proxy, so they need "AIの接続",
    // and they never take a sidecar script override.
    if engine.external_kind().is_some() {
        if connection.is_none() {
            return Err("engine_requires_connection".into());
        }
        if script.is_some() {
            return Err("pi_work_script_not_allowed".into());
        }
    } else {
        warm_model(&model);
    }
    let script = match engine.external_kind() {
        Some(_) => PathBuf::new(),
        None => resolve_script(script)?,
    };
    // The sidecar advertises only the tools this run enabled; the executor
    // would still refuse a call for a tool it wasn't told about, so the env
    // is display discipline, not the boundary.
    let mut caps = Vec::new();
    if allow_exec {
        caps.push("exec");
    }
    if allow_http {
        caps.push("http");
    }
    // `hub_test` is environment-gated, not operator-granted: it exists only
    // when the pinned offline Docker harness is actually reachable.
    let allow_test = crate::docker::isolation_available().await;
    if allow_test {
        caps.push("test");
    }
    let (connection_env, byok_proxy) = match connection {
        Some(connection) => (connection.env, Some(connection.proxy)),
        None => (Vec::new(), None),
    };
    let (spec, engine_run_dir) = match engine.external_kind() {
        Some(kind) => {
            let (spec, run_dir) = external_spec(kind, false, workspace, sidecar_model, prompt, connection_env, &caps)?;
            (spec, Some(run_dir))
        }
        None => (SidecarSpec {
            program: PathBuf::from("node"),
            // argv: script, model, prompt — the sidecar's own convention.
            // Each is one argv element; nothing joins a shell.
            args: vec![
                script.to_string_lossy().into_owned(),
                sidecar_model,
                prompt.to_string(),
            ],
            workspace,
            env: connection_env.into_iter().chain([
                ("PI_SIDECAR_CAPS".to_owned(), caps.join(",")),
                ("PI_SIDECAR_SESSION".into(), "1".into()),
                ("PI_WORK_ENGINE".into(), engine.env_value().into()),
            ]).collect(),
        }, None),
    };
    service
        .start_core_proxied(
            spec,
            model,
            prompt.to_string(),
            allow_write,
            allow_exec,
            allow_http,
            allow_test,
            resume_id,
            leases,
            verification,
            None,
            image_context,
            queue_claim,
            byok_proxy,
            checkers,
            engine_run_dir,)
        .await
}

/// The bridge spec for a type-B engine (`external_engine.rs`): `node bridge.mjs <model> <prompt>`
/// in the workspace, with the pinned engine build, the run folder and the jail. The bridge holds
/// the proxy URL and run token; the engine gets the token, never the key.
pub(crate) fn external_spec(
    kind: crate::external_engine::Kind,
    allow_untested: bool,
    workspace: PathBuf,
    sidecar_model: String,
    prompt: &str,
    connection_env: Vec<(String, String)>,
    caps: &[&str],
) -> Result<(SidecarSpec, crate::external_engine::RunDir), String> {
    let resolved = crate::external_engine::resolve(kind, allow_untested).map_err(|why| why.code.to_owned())?;
    let bridge = crate::external_engine::bridge_script().filter(|path| path.is_file()).ok_or("engine_bridge_missing")?;
    let jail = crate::external_engine::jail_program()?;
    let run_dir = crate::external_engine::create_run_dir()?;
    let env = connection_env.into_iter()
        .chain(crate::external_engine::bridge_env(&resolved, &run_dir, &jail))
        .chain([
            ("PI_SIDECAR_CAPS".to_owned(), caps.join(",")),
            ("PI_SIDECAR_SESSION".into(), "1".into()),
            ("PI_WORK_ENGINE".into(), kind.id().into()),
        ])
        .collect();
    Ok((SidecarSpec {
        program: PathBuf::from("node"),
        args: vec![bridge.to_string_lossy().into_owned(), sidecar_model, prompt.to_owned()],
        workspace,
        env,
    }, run_dir))
}

/// The engine picker: Hub (thin, the default) and the type-B engines with why each is or is not
/// selectable. Display data only; a start resolves the engine again.
#[tauri::command]
pub async fn pi_work_engines(window: tauri::Webview) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    let rows = tokio::task::spawn_blocking(crate::external_engine::catalog).await.map_err(|_| "pi_work_engines_failed".to_owned())?;
    serde_json::to_value(rows).map_err(|_| "pi_work_engines_failed".into())
}

#[tauri::command]
pub async fn pi_work_start(
    window: tauri::Webview,
    workspace: String,
    prompt: String,
    model: Option<String>,
    script: Option<String>,
    allow_write: Option<bool>,
    allow_exec: Option<bool>,
    allow_http: Option<bool>,
    resume_run_id: Option<String>,
    engine: Option<WorkEngine>,
    verification: Option<crate::verification::VerificationCommand>,
    checkers: Option<Vec<crate::verification::VerificationCommand>>,
    best_of: Option<best_of::BestOfRequest>,
    image: Option<NativeImageStart>,
    images: tauri::State<'_, Arc<crate::pi_images::PiImageStore>>,
    service: tauri::State<'_, PiWorkService>,
    state: tauri::State<'_, Arc<crate::RunnerState>>,
) -> Result<PiRunState, String> {
    native_pi(&window)?;
    if window.label() == "main" && script.is_some() {
        return Err("pi_work_script_not_allowed".into());
    }
    let workspace = resolve_workspace(&workspace)?;
    let engine = WorkEngine::for_start(engine, service.saved_engine(resume_run_id.as_deref()));
    validate_engine(engine, resume_run_id.as_deref())?;
    if let Some(request) = best_of {
        if image.is_some() || script.is_some() || resume_run_id.is_some() || engine != WorkEngine::Thin {
            return Err("best_of_unsupported".into());
        }
        return best_of::launch(&service, &state.dev_runs, workspace, &prompt, model.as_deref(),
            allow_exec.unwrap_or(false), allow_http.unwrap_or(false), verification,
            checkers.unwrap_or_default(), request, engine).await;
    }
    let image_context = if native_image_window(&window).is_ok() { Some(NativeImageContext { images: images.inner().clone(), request: image }) } else {
        if image.is_some() { return Err("native_window_required".into()); } None
    };
    launch_inner(
        &service,
        &state.dev_runs,
        workspace,
        &prompt,
        model.as_deref(),
        script.as_deref(),
        allow_write.unwrap_or(false),
        allow_exec.unwrap_or(false),
        allow_http.unwrap_or(false),
        resume_run_id.as_deref(),
        engine,
        verification,
        image_context,
        None,
        checkers.unwrap_or_default(),)
    .await
}

/// Checkers detected from the workspace's project files, for the window to
/// show and the operator to allow. Detection grants nothing by itself.
#[tauri::command]
pub async fn pi_work_detect_checkers(window: tauri::Webview, workspace: String)
    -> Result<Vec<crate::fast_check::DetectedChecker>, String> {
    native_pi(&window)?;
    let workspace = resolve_workspace(&workspace)?;
    tokio::task::spawn_blocking(move || crate::fast_check::detect(&workspace))
        .await.map_err(|_| "pi_work_detect_failed".to_owned())
}

/// The N-attempt token estimate the window shows before a best-of start.
#[tauri::command]
pub async fn pi_work_best_of_estimate(window: tauri::Webview, attempts: u32, token_cap: Option<u64>)
    -> Result<best_of::BestOfEstimate, String> {
    native_pi(&window)?;
    best_of::estimate(attempts, token_cap)
}

#[tauri::command]
pub async fn pi_work_status(
    window: tauri::Webview,
    id: String,
    service: tauri::State<'_, PiWorkService>,
) -> Result<PiRunState, String> {
    native_pi(&window)?;
    service
        .status(&id)
        .ok_or_else(|| "pi_work_not_found".into())
}

#[tauri::command]
pub async fn pi_work_diff(window: tauri::Webview, run_id: String, change_id: String,
    service: tauri::State<'_, PiWorkService>) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.diff(&run_id, &change_id)).await
        .map_err(|_| "pi_changes_unavailable".to_string())?
}

#[tauri::command]
pub async fn pi_work_list(
    window: tauri::Webview,
    service: tauri::State<'_, PiWorkService>,
) -> Result<Vec<PiRunState>, String> {
    native_pi(&window)?;
    Ok(service.list())
}

/// "この作業記録を削除": one finished session, its images and its history line.
#[tauri::command]
pub async fn pi_work_delete(
    window: tauri::Webview,
    id: String,
    service: tauri::State<'_, PiWorkService>,
) -> Result<(), String> {
    native_pi(&window)?;
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.delete(&id)).await
        .map_err(|_| "pi_work_delete_failed".to_string())?
}

/// "AIの作業記録をすべて消す": every finished session; running work stays.
#[tauri::command]
pub async fn pi_work_delete_all(
    window: tauri::Webview,
    service: tauri::State<'_, PiWorkService>,
    state: tauri::State<'_, Arc<crate::RunnerState>>,
) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    let service = service.inner().clone();
    let sessions = tokio::task::spawn_blocking(move || service.delete_all()).await
        .map_err(|_| "pi_work_delete_failed".to_string())??;
    let development = state.dev_runs.lock().await.forget_history();
    Ok(serde_json::json!({ "sessions": sessions, "developmentRuns": development }))
}

#[tauri::command]
pub async fn pi_work_cancel(
    window: tauri::Webview,
    id: String,
    service: tauri::State<'_, PiWorkService>,
    state: tauri::State<'_, Arc<crate::RunnerState>>,
) -> Result<PiRunState, String> {
    native_pi(&window)?;
    service.cancel(&id, &state.dev_runs).await
}

#[tauri::command]
pub async fn pi_work_decide(
    window: tauri::Webview,
    run_id: String,
    action_id: String,
    approve: bool,
    outcome: Option<serde_json::Value>,
    service: tauri::State<'_, PiWorkService>,
) -> Result<PiRunState, String> {
    native_pi(&window)?;
    service.decide_from_window(&run_id, &action_id, approve, outcome)
}

/// The bundled window's model picker reads the same registry probe as the
/// paired panel's `GET /pi-work/models` — cached, display metadata only.
#[tauri::command]
pub async fn pi_work_models(
    window: tauri::Webview,
    refresh: Option<bool>,
    service: tauri::State<'_, PiWorkService>,
) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    Ok(if refresh.unwrap_or(false) {
        service.models_with_refresh(true).await
    } else {
        service.models().await
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::Mutex as AsyncMutex;

    #[tokio::test]
    async fn file_changes_real_executor_checkpoint_restore_and_plaintext_history() {
        let (_guard, root) = temp_workspace();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [17; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService { checkpoints: Some(store.clone()), history: Some(history.clone()), ..Default::default() };
        let script = r#"
const rl=require('node:readline').createInterface({input:process.stdin});
const send=o=>process.stdout.write(JSON.stringify(o)+'\n');
const write=(id,content)=>send({type:'tool_call',id,name:'hub_write',args:{path:'made.txt',content,summary:'synthetic write'}});
send({type:'hello',proto:1,activeTools:['hub_write'],tools:[{name:'hub_write',description:'synthetic',parameters:{type:'object'}}]});
rl.on('line',line=>{const m=JSON.parse(line);if(m.type==='session')write('one','FIRST-PRIVATE-FILE-CONTENT');
else if(m.type==='tool_result'){send({type:'checkpoint',entries:[{type:'session',id:'synthetic',hubEngine:'thin'}]});
if(m.id==='one')write('two','FINAL-PRIVATE-FILE-CONTENT');else{send({type:'agent_done',ok:true});process.exit(0);}}
else if(m.type==='tool_error'){send({type:'agent_done',ok:false});process.exit(1);}});
"#;
        let started = service.start(SidecarSpec { program: "node".into(), args: vec!["-e".into(), script.into()], workspace: root.clone(),
            env: vec![("PI_SIDECAR_SESSION".into(), "1".into()), ("PI_WORK_ENGINE".into(), "thin".into())] }, "synthetic/model".into(), "test changes".into(), true, false, false, false, &leases()).await.unwrap();
        let state = terminal(&service, &started.id).await;
        assert_eq!(state.status, "done", "{:?}", state.outcome);
        assert_eq!(state.changes.status, "tracked"); assert_eq!(state.changes.items.len(), 1);
        let item = &state.changes.items[0]; assert_eq!(item.kind, "created"); assert_eq!(item.before_sha256, None);
        let diff = service.diff(&state.id, &item.id).unwrap();
        assert_eq!(diff["before"], ""); assert_eq!(diff["after"], "FINAL-PRIVATE-FILE-CONTENT"); assert_eq!(diff["currentState"], "matches");
        let saved = store.load::<PiCheckpoint>(&state.id).unwrap(); assert!(saved.file_changes.unwrap().validate()); assert!(valid_context(&saved.entries));
        let plaintext = std::fs::read_to_string(&history).unwrap();
        for content in ["FIRST-PRIVATE-FILE-CONTENT", "FINAL-PRIVATE-FILE-CONTENT"] { assert!(!plaintext.contains(content)); }
        for file in std::fs::read_dir(root.join("saved")).unwrap() {
            let bytes = std::fs::read(file.unwrap().path()).unwrap(); assert!(!String::from_utf8_lossy(&bytes).contains("FINAL-PRIVATE-FILE-CONTENT"));
        }
        let restored = PiWorkService { checkpoints: Some(store), history: Some(history), ..Default::default() }; restored.restore_history();
        assert_eq!(restored.status(&state.id).unwrap().changes.items[0].id, item.id);
        assert_eq!(restored.diff(&state.id, &item.id).unwrap(), diff);
        assert!(restored.run(&state.id).unwrap().wait.lock().unwrap().is_none());
        assert!(restored.diff(&uuid::Uuid::new_v4().to_string(), &item.id).is_err());
        assert!(restored.diff(&state.id, "../../made.txt").is_err());
    }

    #[test]
    fn file_changes_save_failure_keeps_actual_write_visible_and_never_revives_cancelled_run() {
        let (_guard, root) = temp_workspace(); let id = uuid::Uuid::new_v4().to_string();
        let state = Arc::new(Mutex::new(running_state(&id, &root))); state.lock().unwrap().status = "cancelled".into();
        let archive = Arc::new(Mutex::new(PiChangeArchive::new()));
        let observed_state=state.clone(); let observed_archive=archive.clone(); let observed_root=root.clone();
        let mut files=crate::agent_tools::Files::with_change_observer(Arc::new(move |change| {
            let mut state=observed_state.lock().unwrap(); let mut archive=observed_archive.lock().unwrap(); archive.record(change);
            persist_changes(&None, &observed_root, &mut state, &mut archive);
        }));
        let change=files.preview(&root, "made.txt", "visible despite missing encrypted store").unwrap();
        assert!(files.write(&root, &change).is_ok()); let state=state.lock().unwrap();
        assert_eq!(state.status, "cancelled"); assert_eq!(state.changes.status, "incomplete"); assert_eq!(state.changes.reason.as_deref(), Some("save_failed"));
        assert_eq!(state.changes.items.len(), 1); assert_eq!(archive.lock().unwrap().diff(&root, &state.changes.items[0].id).unwrap().current_state, "matches");
    }

    #[test]
    fn file_changes_interrupted_before_conversation_restores_only_dead_display_state() {
        let (_guard, root) = temp_workspace(); let id=uuid::Uuid::new_v4().to_string(); let store=crate::checkpoint::CheckpointStore::test(root.join("saved"), [18;32]);
        let mut state=running_state(&id,&root); let mut archive=PiChangeArchive::new();
        std::fs::write(root.join("made.txt"), "recovered private file").unwrap();
        archive.record(crate::agent_tools::Change {path:"made.txt".into(),before:String::new(),after:"recovered private file".into(),previous_sha256:None,sha256:crate::agent_tools::digest(b"recovered private file")});
        persist_changes(&Some(store.clone()), &root, &mut state, &mut archive);
        let service=PiWorkService {checkpoints:Some(store), ..Default::default()}; service.restore_history();
        let recovered=service.status(&id).unwrap(); assert_eq!(recovered.status,"failed"); assert!(!recovered.continuation.available);
        assert_eq!(recovered.outcome.unwrap().error.as_deref(),Some("pi_session_interrupted_changes_available"));
        assert_eq!(service.diff(&id,&recovered.changes.items[0].id).unwrap()["after"],"recovered private file");
        assert!(service.run(&id).unwrap().wait.lock().unwrap().is_none()); assert!(service.resume_context(&id,&root).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn file_changes_terminal_save_recovers_latest_archive_after_actual_replace_failure() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_guard,root)=temp_workspace();let id=uuid::Uuid::new_v4().to_string();let store=crate::checkpoint::CheckpointStore::test(root.join("saved"),[19;32]);
        let service=PiWorkService{checkpoints:Some(store.clone()),..Default::default()};let state=Arc::new(Mutex::new(running_state(&id,&root)));
        insert_run(&service,&id,&root,state.clone(),Arc::new(Mutex::new(HashMap::new())));let run=service.run(&id).unwrap();
        *run.file_changes.lock().unwrap()=PiChangeArchive::new();
        let observed_run=run.clone();let observed_store=store.clone();
        let mut files=crate::agent_tools::Files::with_change_observer(Arc::new(move|change|{
            let mut state=observed_run.state.lock().unwrap();let mut archive=observed_run.file_changes.lock().unwrap();archive.record(change);
            persist_changes(&Some(observed_store.clone()),&observed_run.workspace,&mut state,&mut archive);
        }));
        let proposal=files.preview(&root,"made.txt","first").unwrap();files.write(&root,&proposal).unwrap();
        let locked=std::fs::OpenOptions::new().read(true).share_mode(1).open(root.join("saved").join(format!("{id}.jkcp"))).unwrap();
        files.read(&root,"made.txt").unwrap();let proposal=files.preview(&root,"made.txt","latest").unwrap();files.write(&root,&proposal).unwrap();
        assert_eq!(run.state.lock().unwrap().changes.reason.as_deref(),Some("save_failed"));
        let stale=store.load::<PiCheckpoint>(&id).unwrap();assert_eq!(stale.file_changes.unwrap().diff(&root,&run.state.lock().unwrap().changes.items[0].id).unwrap().after,"first");
        drop(locked);run.state.lock().unwrap().status="done".into();let snapshot=PiWorkService::snapshot(&run);service.record_terminal(&run.recorded,&snapshot);
        let saved=store.load::<PiCheckpoint>(&id).unwrap();let archive=saved.file_changes.unwrap();assert_eq!(archive.diff(&root,&snapshot.changes.items[0].id).unwrap().after,"latest");
        assert_eq!(archive.summary().reason.as_deref(),Some("save_failed"));
    }

    #[test]
    fn file_changes_terminal_does_not_overwrite_unreadable_checkpoint() {
        let (_guard,root)=temp_workspace();let id=uuid::Uuid::new_v4().to_string();let store=crate::checkpoint::CheckpointStore::test(root.join("saved"),[20;32]);
        let service=PiWorkService{checkpoints:Some(store.clone()),..Default::default()};let mut terminal=running_state(&id,&root);terminal.status="done".into();
        let state=Arc::new(Mutex::new(terminal));insert_run(&service,&id,&root,state,Arc::new(Mutex::new(HashMap::new())));let run=service.run(&id).unwrap();
        std::fs::write(root.join("saved").join(format!("{id}.jkcp")),b"unreadable").unwrap();let snapshot=PiWorkService::snapshot(&run);service.record_terminal(&run.recorded,&snapshot);
        assert_eq!(std::fs::read(root.join("saved").join(format!("{id}.jkcp"))).unwrap(),b"unreadable");
        assert_eq!(run.state.lock().unwrap().changes.reason.as_deref(),Some("save_failed"));
    }

    #[test]
    fn thin_is_the_only_engine_for_new_work_and_the_standard_engine_is_refused() {
        // 2026-10-18 owner decision: the standard engine is deleted. New work, script overrides
        // and image prompts run thin; a resume with no engine keeps the saved run's engine, so a
        // saved standard run reaches validate_engine and is refused instead of silently switching.
        assert_eq!(WorkEngine::for_start(None, None), WorkEngine::Thin);
        assert_eq!(WorkEngine::for_start(None, Some(WorkEngine::Thin)), WorkEngine::Thin);
        assert_eq!(WorkEngine::for_start(None, Some(WorkEngine::Pi)), WorkEngine::Pi);
        assert_eq!(WorkEngine::for_start(Some(WorkEngine::Dsh), Some(WorkEngine::Pi)), WorkEngine::Dsh);
        // Saved records that predate the engine field were standard runs: they still deserialize.
        assert_eq!(WorkEngine::default(), WorkEngine::Pi);
        assert_eq!(validate_engine(WorkEngine::Pi, None).unwrap_err(), STANDARD_ENGINE_RETIRED);
        assert_eq!(validate_engine(WorkEngine::Pi, Some("saved-pi")).unwrap_err(), STANDARD_ENGINE_RETIRED);
        assert!(validate_engine(WorkEngine::Thin, None).is_ok());
        assert!(validate_engine(WorkEngine::Thin, Some("saved")).is_ok(), "thin runs resume");
        assert!(validate_engine(WorkEngine::Dsh, Some("saved-dsh")).is_ok());
        assert_eq!(validate_engine(WorkEngine::Dsh, None).unwrap_err(), "legacy_engine_requires_resume");
        // The checkpoint header decides which engine wrote it; unknown markers fail closed.
        assert_eq!(context_engine(&json!([{"type":"session","id":"s"}])), Some(WorkEngine::Pi));
        assert_eq!(context_engine(&json!([{"type":"session","id":"s","hubEngine":"thin"}])), Some(WorkEngine::Thin));
        assert_eq!(context_engine(&json!([{"type":"session","id":"s","hubEngine":"pi"}])), None);
        assert_eq!(context_engine(&json!([{"type":"session","id":"s","hubEngine":7}])), None);
    }

    /// A spec that does not name thin or dsh (the standard engine, or none) never spawns.
    #[tokio::test]
    async fn start_core_refuses_the_standard_engine_before_spawning() {
        let (_guard, root) = temp_workspace();
        let marker = root.join("spawned.txt");
        let script = root.join("spawn-marker.mjs");
        std::fs::write(&script, format!("require('fs').writeFileSync({:?}, 'x')", marker.to_string_lossy())).unwrap();
        let service = PiWorkService::default();
        let leases = Arc::new(tokio::sync::Mutex::new(DevRuns::default()));
        for env in [vec![("PI_WORK_ENGINE".to_owned(), "pi".to_owned())], Vec::new()] {
            let spec = SidecarSpec { program: "node".into(), args: vec![script.to_string_lossy().into_owned()], workspace: root.clone(), env };
            let error = service.start_core(spec, "stub".into(), "p".into(), false, false, false, false, None, &leases, None, None)
                .await.unwrap_err();
            assert_eq!(error, STANDARD_ENGINE_RETIRED);
        }
        assert!(!marker.exists(), "nothing was spawned");
        assert!(service.list().is_empty(), "no run record");
    }

    fn retention_fixture(root: &Path) -> (PiWorkService, PathBuf, [String; 3], [String; 3]) {
        let store = crate::checkpoint::CheckpointStore::test(root.join("sessions"), [21; 32]);
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        let history = root.join("history.jsonl");
        let now = now_ms();
        let day = 24 * 60 * 60 * 1000u128;
        let ids = [0, 1, 2].map(|_| uuid::Uuid::new_v4().to_string());
        let pictures = [0, 1, 2].map(|_| uuid::Uuid::new_v4().to_string());
        let reference = |id: &str| crate::pi_images::ImageReference { id: id.into(), mime_type: "image/png".into(), size_bytes: 10, sha256: "0".repeat(64) };
        // ids[0] is 100 days old; ids[1] and ids[2] are recent. pictures[2] is shared by ids[0] and ids[1].
        for (index, (id, age)) in ids.iter().zip([100 * day, day, 0]).enumerate() {
            let mut state = running_state(id, root);
            state.status = "done".into();
            state.started_at_ms = now - age - 1000;
            state.ended_at_ms = Some(now - age);
            if index < 2 { state.image_context_refs = vec![reference(&pictures[index]), reference(&pictures[2])]; }
            store.save(id, &PiCheckpoint { workspace: root.to_path_buf(), entries: serde_json::Value::Null, run: Some(state.clone()), file_changes: None, read_observations: None }).unwrap();
            append_history(&history, &state).unwrap();
        }
        for picture in &pictures { std::fs::write(images.join(format!("{picture}.jkcp")), b"x").unwrap(); }
        let old = std::time::SystemTime::now() - Duration::from_secs(100 * 24 * 60 * 60);
        for path in [root.join("sessions").join(format!("{}.jkcp", ids[0])), images.join(format!("{}.jkcp", pictures[0])), images.join(format!("{}.jkcp", pictures[2]))] {
            std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(old).unwrap();
        }
        let service = PiWorkService { checkpoints: Some(store), history: Some(history.clone()), images: Some(images), ..Default::default() };
        service.restore_history();
        (service, history, ids, pictures)
    }

    #[test]
    fn records_older_than_ninety_days_go_but_shared_images_stay() {
        let (_guard, root) = temp_workspace();
        let (service, history, ids, pictures) = retention_fixture(&root);
        assert_eq!(service.list().len(), 3);
        assert_eq!(service.prune_expired(), 1);
        let listed: Vec<String> = service.list().into_iter().map(|run| run.id).collect();
        assert!(!listed.contains(&ids[0]) && listed.contains(&ids[1]) && listed.contains(&ids[2]));
        assert!(!std::fs::read_to_string(&history).unwrap().contains(&ids[0]));
        assert!(!root.join("sessions").join(format!("{}.jkcp", ids[0])).exists());
        let images = root.join("images");
        assert!(!images.join(format!("{}.jkcp", pictures[0])).exists(), "old image of the old session");
        assert!(images.join(format!("{}.jkcp", pictures[2])).exists(), "old image still used by a recent session");
        assert!(images.join(format!("{}.jkcp", pictures[1])).exists());
        // Restarting reads back only what is left.
        let again = PiWorkService { checkpoints: service.checkpoints.clone(), history: Some(history), ..Default::default() };
        again.restore_history();
        assert_eq!(again.list().len(), 2);
    }

    #[test]
    fn deleting_one_session_and_then_all() {
        let (_guard, root) = temp_workspace();
        let (service, history, ids, pictures) = retention_fixture(&root);
        let images = root.join("images");
        assert!(service.delete("not-a-uuid").is_err());
        service.delete(&ids[1]).unwrap();
        assert!(service.status(&ids[1]).is_none());
        assert!(!std::fs::read_to_string(&history).unwrap().contains(&ids[1]));
        assert!(!root.join("sessions").join(format!("{}.jkcp", ids[1])).exists());
        assert!(!images.join(format!("{}.jkcp", pictures[1])).exists());
        assert!(images.join(format!("{}.jkcp", pictures[2])).exists(), "ids[0] still uses it");
        assert_eq!(service.delete_all().unwrap(), 2);
        assert!(service.list().is_empty());
        assert_eq!(std::fs::read_to_string(&history).unwrap(), "");
        assert_eq!(crate::checkpoint::record_ids(&images).len(), 0);
        assert_eq!(crate::checkpoint::record_ids(&root.join("sessions")).len(), 0);
    }

    fn temp_workspace() -> (crate::agent_tools::TestWorkspace, PathBuf) {
        let path = std::env::temp_dir().join(format!("hub-pi-work-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let path = path.canonicalize().unwrap();
        (
            crate::agent_tools::TestWorkspace { path: path.clone() },
            path,
        )
    }

    fn leases() -> Arc<AsyncMutex<DevRuns>> {
        Arc::new(AsyncMutex::new(DevRuns::default()))
    }

    async fn terminal(service: &PiWorkService, id: &str) -> PiRunState {
        for _ in 0..200 {
            if let Some(state) = service.status(id) {
                if state.status != "running" {
                    return state;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("run did not reach a terminal state");
    }

    #[test]
    fn resolve_workspace_accepts_only_existing_directories() {
        let (_guard, root) = temp_workspace();
        assert_eq!(resolve_workspace(root.to_str().unwrap()).unwrap(), root);
        assert_eq!(
            resolve_workspace(root.join("missing").to_str().unwrap()).unwrap_err(),
            "workspace_not_found"
        );
        let file = root.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            resolve_workspace(file.to_str().unwrap()).unwrap_err(),
            "workspace_not_found"
        );
    }

    #[test]
    fn resolve_script_requires_an_existing_file() {
        let (_guard, root) = temp_workspace();
        assert_eq!(
            resolve_script(Some(root.join("missing.mjs").to_str().unwrap())).unwrap_err(),
            "sidecar_script_missing"
        );
        let script = root.join("sidecar.mjs");
        std::fs::write(&script, "// stub\n").unwrap();
        let resolved = resolve_script(Some(script.to_str().unwrap())).unwrap();
        // Canonicalized for validation, but verbatim prefixes must not reach
        // the child's argv — Node cannot load `\\?\` entry points on Windows.
        assert_eq!(resolved, non_verbatim(script.canonicalize().unwrap()));
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
    }

    /// A checkout carries the vendored bundle under `apps/hub-desktop/vendor`,
    /// so a fresh clone (or a parallel CI session) can run pi_work with no
    /// script argument and no app-data install step.
    #[test]
    fn resolve_script_defaults_to_the_repo_vendor() {
        // `default_script` honours PI_WORK_SIDECAR first; serialise against
        // the env-redirecting tests and clear it so the repo path is what
        // actually resolves.
        let _env = crate::local_cli::ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous = std::env::var_os("PI_WORK_SIDECAR");
        std::env::remove_var("PI_WORK_SIDECAR");
        let resolved = resolve_script(None);
        match previous {
            Some(value) => std::env::set_var("PI_WORK_SIDECAR", value),
            None => {}
        }
        let path = resolved.expect("the repo vendor must resolve");
        assert!(path.is_file());
    }

    #[test]
    fn run_state_serializes_camel_case() {
        let state = PiRunState {
            image_attachments: Vec::new(), image_context_refs: Vec::new(), prompt_image_ids: Vec::new(), reattached_image_ids: Vec::new(), image_request_id: None, image_receipt_valid: true,
            fast_check: None, best_of: None,
            generation: None, supports_steering: false, instructions: Vec::new(), changes: PiChangeSummary::default(),
            verification: None,
            engine: WorkEngine::Thin,
            usage: PiUsage::default(),
            final_output: String::new(),
            continuation: PiContinuation::default(),
            id: "r1".into(),
            workspace: "C:/w".into(),
            script: "C:/s/pi-sidecar.mjs".into(),
            model: "ollama/m".into(),
            prompt: "do it".into(),
            allow_write: true,
            allow_exec: false,
            allow_http: false,
            allow_test: false,
            status: "running".into(),
            hello: Some(PiHello {
                generation: None, supports_steering: false, proto: 1,
                active_tools: vec!["hub_read".into()],
                tools: vec![],
                model: Some("ollama/qwen2.5:3b".into()),
                available: Some(vec!["ollama/qwen2.5:3b".into()]),
            }),
            tool_calls: vec![
                PiToolCall {
                    id: "tc_1".into(),
                    name: "hub_read".into(),
                    detail: Some("src/main.rs".into()),
                    ok: None,
                    preview: None,
                },
                PiToolCall {
                    id: "tc_2".into(),
                    name: "hub_list".into(),
                    detail: None,
                    ok: Some(false),
                    preview: Some("denied".into()),
                },
            ],
            pending_actions: vec![PiPendingAction {
                id: "pa_1".into(),
                tool: "hub_write".into(),
                summary: "write a.txt (3 bytes)".into(),
                detail: serde_json::Value::Null,
                proposed_at_ms: 6,
            }],
            agent_events: 3,
            partial_output: "streaming".into(),
            outcome: None,
            stderr_tail: "warn".into(),
            started_at_ms: 7,
            ended_at_ms: None,
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["allowWrite"], true);
        assert_eq!(value["toolCalls"].as_array().unwrap().len(), 2);
        assert_eq!(value["agentEvents"], 3);
        assert_eq!(value["partialOutput"], "streaming");
        assert_eq!(value["stderrTail"], "warn");
        assert_eq!(value["startedAtMs"], 7);
        assert!(value["hello"]["activeTools"].is_array());
        assert_eq!(value["hello"]["model"], "ollama/qwen2.5:3b");
        assert_eq!(value["hello"]["available"], json!(["ollama/qwen2.5:3b"]));
        // An unsettled call keeps `ok` optional rather than null.
        assert!(value["toolCalls"][0].get("ok").is_none());
        assert_eq!(value["toolCalls"][1]["ok"], false);
        assert_eq!(value["pendingActions"][0]["tool"], "hub_write");
        assert_eq!(value["pendingActions"][0]["proposedAtMs"], 6);
        assert!(value.get("endedAtMs").is_some());
        assert!(value["endedAtMs"].is_null());
    }

    #[test]
    fn usage_counts_complete_assistant_and_compaction_reports_and_saturates() {
        let mut usage = PiUsage::default();
        let event = json!({"type":"message_end","message":{"role":"assistant","usage":{
            "input":10,"output":3,"cacheRead":100,"cacheWrite":5
        }}});
        usage.observe(&event);
        usage.observe(&event);
        assert_eq!(
            (
                usage.requests,
                usage.input,
                usage.output,
                usage.cache_read,
                usage.cache_write
            ),
            (2, 20, 6, 200, 10)
        );
        for invalid in [
            json!({"type":"message_update"}),
            json!({"type":"message_end","message":{"role":"toolResult","usage":event["message"]["usage"]}}),
            json!({"type":"message_end","message":{"role":"assistant","usage":{"input":-1,"output":3,"cacheRead":0,"cacheWrite":0}}}),
        ] {
            usage.observe(&invalid);
        }
        assert_eq!(usage.requests, 2);
        usage.observe(&json!({"type":"compaction_usage","usage":event["message"]["usage"]}));
        assert_eq!((usage.requests, usage.input, usage.output), (3, 30, 9));
        // The SDK also emits an aggregate summary; counting it doubles usage.
        usage.observe(
            &json!({"type":"compaction_end","result":{"usage":event["message"]["usage"]}}),
        );
        assert_eq!((usage.requests, usage.input, usage.output), (3, 30, 9));
        usage.input = u64::MAX;
        usage.observe(&event);
        assert_eq!(usage.input, u64::MAX);
    }

    #[tokio::test]
    #[ignore = "requires node; isolated model-list fixture, no credentials or inference"]
    async fn model_cache_invalidates_configuration_refresh_expiry_and_failures() {
        let _env = crate::local_cli::ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let old_dir = std::env::var_os("PI_CODING_AGENT_DIR");
        let old_script = std::env::var_os("PI_WORK_SIDECAR");
        let (_guard, root) = temp_workspace();
        let script = root.join("catalog.cjs");
        std::fs::write(&script, r#"
const fs = require('node:fs'), path = require('node:path');
const file = name => path.join(__dirname, name);
const count = fs.existsSync(file('count')) ? +fs.readFileSync(file('count'), 'utf8') : 0;
fs.writeFileSync(file('count'), String(count + 1));
if (fs.existsSync(file('fail'))) process.exit(1);
console.log(JSON.stringify({type:'models',models:['test/a'],ready:JSON.parse(fs.readFileSync(file('auth.json'),'utf8')),locations:{'test/a':'local'}}));
"#).unwrap();
        std::fs::write(root.join("auth.json"), "[\"test/a\"]").unwrap();
        std::env::set_var("PI_CODING_AGENT_DIR", &root);
        std::env::set_var("PI_WORK_SIDECAR", non_verbatim(script));
        let service = PiWorkService::default();
        let count = || std::fs::read_to_string(root.join("count")).unwrap();
        let initial = service.models().await;
        for _ in 0..10 {
            assert_eq!(service.models().await, initial);
        }
        assert_eq!(count(), "1");
        std::fs::write(root.join("auth.json"), "[]").unwrap();
        assert_eq!(service.models().await["ready"], json!([]));
        assert_eq!(count(), "2");
        service.models_with_refresh(true).await;
        assert_eq!(count(), "3");
        service.model_probe.lock().await.as_mut().unwrap().at -= Duration::from_secs(11);
        service.models().await;
        assert_eq!(count(), "4");
        std::fs::write(root.join("fail"), "").unwrap();
        assert!(service
            .models_with_refresh(true)
            .await
            .get("ready")
            .is_none());
        assert!(service.model_probe.lock().await.is_none());
        std::fs::remove_file(root.join("fail")).unwrap();
        assert_eq!(service.models().await["models"], json!(["test/a"]));
        for (key, old) in [
            ("PI_CODING_AGENT_DIR", old_dir),
            ("PI_WORK_SIDECAR", old_script),
        ] {
            match old {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires vendored Pi and node; read-only catalog benchmark, no inference"]
    async fn model_cache_matches_fresh_real_catalog_over_repeated_picker_reads() {
        let _env = crate::local_cli::ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let service = PiWorkService::default();
        let mut fresh_ms = Vec::new();
        let mut cached_ms = Vec::new();
        for _ in 0..3 {
            let start = std::time::Instant::now();
            let reference = service.models_with_refresh(true).await;
            fresh_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            assert!(!reference["models"].as_array().unwrap().is_empty());
            for _ in 0..10 {
                let start = std::time::Instant::now();
                let actual = service.models().await;
                cached_ms.push(start.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(
                    actual, reference,
                    "cached catalog differs from forced fresh reference"
                );
            }
        }
        eprintln!("catalog fresh_ms={fresh_ms:?} cached_ms={cached_ms:?}");
    }

    #[test]
    fn session_context_rejects_missing_corrupt_oversized_and_other_workspaces() {
        let (_guard, root) = temp_workspace();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [7; 32]);
        let service = PiWorkService {
            checkpoints: Some(store.clone()),
            ..PiWorkService::default()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let mut state = running_state(&id, &root);
        state.status = "done".into();
        insert_run(
            &service,
            &id,
            &root,
            Arc::new(Mutex::new(state)),
            Arc::new(Mutex::new(HashMap::new())),
        );
        assert_eq!(
            service.resume_context(&id, &root).unwrap_err(),
            "pi_session_unavailable"
        );
        let entries = json!([{"type":"session", "id":"fixture", "hubEngine":"thin"}]);
        store
            .save(
                &id,
                &PiCheckpoint {
                    file_changes: None, read_observations: None,
                    workspace: root.clone(),
                    entries: entries.clone(),
                    run: None,
                },
            )
            .unwrap();
        assert_eq!(service.resume_context(&id, &root).unwrap(), entries);
        assert_eq!(
            service
                .resume_context(&id, &root.join("other"))
                .unwrap_err(),
            "pi_session_workspace_mismatch"
        );
        service.run(&id).unwrap().state.lock().unwrap().status = "running".into();
        assert_eq!(
            service.resume_context(&id, &root).unwrap_err(),
            "pi_work_still_running"
        );
        service.run(&id).unwrap().state.lock().unwrap().status = "done".into();
        std::fs::write(root.join("saved").join(format!("{id}.jkcp")), "corrupt").unwrap();
        assert_eq!(
            service.resume_context(&id, &root).unwrap_err(),
            "pi_session_unavailable"
        );
        assert!(!valid_context(&json!(null)));
        assert!(!valid_context(&json!([])));
        assert!(!valid_context(&json!([{"type":"message"}])));
        assert!(!valid_context(
            &json!([{"type":"session", "text":"x".repeat(MAX_CONTEXT_BYTES)}])
        ));
        assert!(!valid_context(&json!(vec![
            json!({"type":"session"});
            10001
        ])));
        let dsh =
            |id: &str, version: u32| json!([{"type":"dsh-session", "version":version, "id":id}]);
        assert_eq!(
            context_engine(&dsh("hub-abc-123", 1)),
            Some(WorkEngine::Dsh)
        );
        assert_eq!(context_engine(&entries), Some(WorkEngine::Thin));
        for id in ["hub-", "../secret", "hub-a/b", "hub-会話"] {
            assert!(!valid_context(&dsh(id, 1)));
        }
        assert!(valid_context(&dsh(&format!("hub-{}", "a".repeat(80)), 1)));
        assert!(!valid_context(&dsh(&format!("hub-{}", "a".repeat(81)), 1)));
        assert!(!valid_context(&dsh("hub-abc", 2)));
    }

    #[test]
    fn final_output_is_bounded_text_and_never_a_tool_or_failed_response() {
        let event = json!({"type":"message_end","message":{"role":"assistant","stopReason":"stop",
            "content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"長".repeat(MAX_PARTIAL_OUTPUT_CHARS + 1)}]}});
        let text = final_text(&event).unwrap();
        assert!(text.starts_with(&"長".repeat(MAX_PARTIAL_OUTPUT_CHARS)));
        assert!(text.ends_with("[output truncated]"));
        let mut event = event;
        event["message"]["stopReason"] = json!("toolUse");
        assert!(final_text(&event).is_none());
        event["message"]["stopReason"] = json!("error");
        assert!(final_text(&event).is_none());
    }

    #[test]
    fn interrupted_checkpoint_restores_as_failed_without_live_authority() {
        let (_guard, root) = temp_workspace();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [9; 32]);
        let id = uuid::Uuid::new_v4().to_string();
        let mut state = running_state(&id, &root);
        state.pending_actions.push(PiPendingAction {
            id: "old-approval".into(),
            tool: "hub_edit".into(),
            summary: "old".into(),
            detail: json!(null),
            proposed_at_ms: 0,
        });
        state.partial_output = "unfinished".into();
        store
            .save(
                &id,
                &PiCheckpoint {
                    file_changes: None, read_observations: None,
                    workspace: root.clone(),
                    entries: json!([{"type":"session","hubEngine":"thin"}]),
                    run: Some(state),
                },
            )
            .unwrap();
        let restored = PiWorkService {
            checkpoints: Some(store),
            ..PiWorkService::default()
        };
        restored.restore_history();
        let view = restored.status(&id).unwrap();
        assert_eq!(view.status, "failed");
        assert!(view.continuation.available);
        assert!(view.pending_actions.is_empty() && view.partial_output.is_empty());
        assert_eq!(
            restored
                .decide(&id, "old-approval", true, None)
                .unwrap_err(),
            "pi_action_not_found"
        );
        assert!(restored.run(&id).unwrap().wait.lock().unwrap().is_none());
        assert!(restored.resume_context(&id, &root).is_ok());
    }

    #[test]
    fn dsh_result_is_encrypted_and_restores_without_resume_authority() {
        let (_guard, root) = temp_workspace();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [3; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService {
            history: Some(history.clone()),
            checkpoints: Some(store.clone()),
            ..PiWorkService::default()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let mut state = running_state(&id, &root);
        state.engine = WorkEngine::Dsh;
        state.status = "done".into();
        state.final_output = "PRIVATE-DSH-RESULT".into();
        service.record_terminal(&AtomicBool::new(false), &state);
        assert!(!std::fs::read_to_string(&history)
            .unwrap()
            .contains("PRIVATE-DSH-RESULT"));
        let saved = store.load::<PiCheckpoint>(&id).unwrap();
        assert!(!valid_context(&saved.entries));
        service.restore_history();
        let restored = service.status(&id).unwrap();
        assert_eq!(restored.engine, WorkEngine::Dsh);
        assert_eq!(restored.final_output, "PRIVATE-DSH-RESULT");
        assert!(!restored.continuation.available);
        assert_eq!(
            service.resume_context(&id, &root).unwrap_err(),
            "pi_session_invalid"
        );
        assert!(serde_json::from_str::<WorkEngine>("\"arbitrary-script\"").is_err());
    }

    #[tokio::test]
    #[ignore = "explicit local-only acceptance: PI_WORK_MODEL=ollama/...; two real model turns"]
    async fn vendored_pi_real_local_session_resumes_observed_content_with_fresh_permissions() {
        let _env = crate::local_cli::ENV_LOCK
            .lock().unwrap_or_else(|error| error.into_inner());
        let model = std::env::var("PI_WORK_MODEL").expect("explicit local PI_WORK_MODEL required");
        assert!(model.starts_with("ollama/") && model.len() > "ollama/".len(),
            "only an explicit local Ollama model is authorized");
        assert_eq!(crate::dev_cli::model_name(Some(&model), DEFAULT_MODEL), model,
            "invalid model must not fall back to another provider");
        assert!(std::env::var_os("PI_WORK_SIDECAR").is_none(), "use reviewed vendored sidecar");
        assert!(std::env::var_os("PI_POC_SCENARIO").is_none(), "SDK stub is not real inference");
        let script = resolve_script(None).expect("vendored sidecar required");
        assert!(script.is_file());
        let (_guard, root) = temp_workspace();
        let marker = format!("LOCAL-RESUME-{}", uuid::Uuid::new_v4());
        std::fs::write(root.join("notes.txt"), &marker).unwrap();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [23; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService {
            checkpoints: Some(store.clone()), history: Some(history.clone()),
            ..PiWorkService::default()
        };
        let leases = leases();
        let spec = |prompt: &str| SidecarSpec {
            program: "node".into(),
            args: vec![script.to_string_lossy().into_owned(), model.clone(), prompt.into()],
            workspace: root.clone(),
            env: vec![
                ("PI_WORK_ENGINE".into(), "thin".into()),
                ("PI_SIDECAR_SESSION".into(), "1".into()),
                ("PI_SIDECAR_CAPS".into(), "".into()),
                ("PI_CODING_AGENT_DIR".into(),
                    non_verbatim(root.join("agent-dir")).to_string_lossy().into_owned()),
            ],
        };
        // The marker never appears in a prompt: only the actual read can reveal it.
        let prompt = "Use hub_read with path notes.txt. Remember the complete exact contents for this conversation. Reply with those exact contents. Do not write or run commands.";
        let first = service.start_with_resume(spec(prompt), model.clone(), prompt.into(),
            false, false, false, false, None, &leases, None).await.unwrap();
        let (first, approvals) = local_resume_terminal(&service, &leases, &first.id, &root, None).await;
        assert_eq!(approvals, 0);
        assert_eq!(first.status, "done", "local read did not complete");
        assert!(first.tool_calls.iter().any(|call| call.name == "hub_read"
            && call.detail.as_deref() == Some("notes.txt") && call.ok == Some(true)
            && call.preview.as_deref() == Some(marker.as_str())), "actual read content not observed");
        assert!(first.final_output.contains(&marker), "model did not retain the read contents");
        assert!(first.continuation.available, "encrypted continuation unavailable");
        assert_eq!(first.engine, WorkEngine::Thin);
        assert_eq!(first.model, model);
        assert!(!first.allow_write && !first.allow_exec && !first.allow_http && !first.allow_test);
        assert!(first.continuation.resumed_from.is_none());
        let checkpoint = store.load::<PiCheckpoint>(&first.id).expect("authenticated checkpoint");
        assert_eq!(checkpoint.workspace, root);
        assert_eq!(context_engine(&checkpoint.entries), Some(WorkEngine::Thin));
        assert!(checkpoint.entries.to_string().contains(&marker));
        let encrypted = std::fs::read(root.join("saved").join(format!("{}.jkcp", first.id))).unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains(&marker));
        assert!(!std::fs::read_to_string(&history).unwrap().contains(&marker));

        // Change the source before a fresh service resumes the encrypted conversation.
        let replacement = format!("REPLACED-{}", uuid::Uuid::new_v4());
        std::fs::write(root.join("notes.txt"), &replacement).unwrap();
        assert!(!root.join("answer.txt").exists());
        let restored = PiWorkService {
            checkpoints: Some(store), history: Some(history), ..PiWorkService::default()
        };
        restored.restore_history();
        assert!(restored.run(&first.id).unwrap().wait.lock().unwrap().is_none());
        let prompt = "Continue our conversation. notes.txt has changed. Do not read its current contents. Use hub_write to create answer.txt containing exactly the original complete contents you read earlier, with no added whitespace or newline. Request approval for that write. Do not edit any other file or run commands.";
        let resumed = restored.start_with_resume(spec(prompt), model.clone(), prompt.into(),
            false, false, false, false, Some(&first.id), &leases, None).await.unwrap();
        // Check identity before polling without abandoning a live run on assertion failure.
        let identity_matches = resumed.id != first.id && resumed.engine == WorkEngine::Thin
            && resumed.model == first.model && resumed.workspace == first.workspace
            && resumed.script == first.script
            && resumed.continuation.resumed_from.as_deref() == Some(first.id.as_str())
            && !resumed.allow_write && !resumed.allow_exec && !resumed.allow_http && !resumed.allow_test;
        let (done, approvals) = local_resume_terminal(&restored, &leases, &resumed.id,
            &root, identity_matches.then_some(marker.as_str())).await;
        assert!(identity_matches, "resume changed native identity, workspace or permissions");
        assert_eq!(done.status, "done", "local resume did not complete");
        assert_eq!(approvals, 1, "only the exact new-file proposal can be approved");
        assert!(done.tool_calls.iter().any(|call| call.name == "hub_write"
            && call.detail.as_deref() == Some("answer.txt") && call.ok == Some(true)));
        assert_eq!(std::fs::read_to_string(root.join("answer.txt")).unwrap(), marker,
            "independent file evidence, not assistant success claims");
        assert_eq!(std::fs::read_to_string(root.join("notes.txt")).unwrap(), replacement);
        assert!(done.continuation.available);
        assert!(leases.lock().await.reserve_work(&root, "fixture-finished").is_ok());
    }

    #[tokio::test]
    #[ignore = "explicit local-only acceptance: PI_WORK_MODEL=ollama/...; real same-run steering"]
    async fn vendored_pi_real_local_same_run_steering_changes_only_approved_target() {
        let _env = crate::local_cli::ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let model = std::env::var("PI_WORK_MODEL").expect("explicit local PI_WORK_MODEL required");
        assert!(model.starts_with("ollama/") && model.len() > "ollama/".len(),
            "only an explicit local Ollama model is authorized");
        assert_eq!(crate::dev_cli::model_name(Some(&model), DEFAULT_MODEL), model);
        for name in ["PI_WORK_SIDECAR", "PI_POC_SCENARIO"] {
            assert!(std::env::var_os(name).is_none(), "sidecar or SDK stub override is forbidden");
        }
        let vendored = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..").join("vendor/pi-sidecar/pi-sidecar.mjs");
        let script = resolve_script(None).expect("reviewed vendored sidecar required");
        assert_eq!(script, non_verbatim(vendored.canonicalize().unwrap()));
        let (_guard, root) = temp_workspace();
        let marker = format!("LOCAL-STEER-{}", uuid::Uuid::new_v4());
        let original = format!("UNCHANGED-{}", uuid::Uuid::new_v4());
        std::fs::write(root.join("keep.txt"), &original).unwrap();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [29; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService {
            checkpoints: Some(store.clone()), history: Some(history.clone()), ..Default::default()
        };
        let leases = leases();
        let prompt = "Use the write tool to propose creating obsolete.txt with exactly OBSOLETE-LOCAL-PROPOSAL, with no newline. Request approval. Do not read, edit or write other files, or run commands.";
        let spec = SidecarSpec {
            program: "node".into(),
            args: vec![script.to_string_lossy().into_owned(), model.clone(), prompt.into()],
            workspace: root.clone(),
            env: vec![("PI_WORK_ENGINE".into(), "thin".into()),
                ("PI_SIDECAR_SESSION".into(), "1".into()), ("PI_SIDECAR_CAPS".into(), "".into()),
                ("PI_CODING_AGENT_DIR".into(), non_verbatim(root.join("agent-dir")).to_string_lossy().into_owned())],
        };
        let started = service.start_with_resume(spec, model.clone(), prompt.into(),
            false, false, false, false, None, &leases, None).await.unwrap();
        let result: Result<(), String> = async {
            let before = tokio::time::timeout(Duration::from_secs(120), async {
                loop {
                    let view = service.status(&started.id).ok_or("owned_run_missing")?;
                    if view.status != "running" { return Err("initial_run_ended_before_approval"); }
                    if !view.pending_actions.is_empty() {
                        let action = &view.pending_actions[0];
                        let change = serde_json::from_value::<crate::agent_tools::Change>(action.detail.clone());
                        if view.pending_actions.len() != 1 || action.tool != "hub_write"
                            || !change.is_ok_and(|change| change.path == "obsolete.txt"
                                && change.before.is_empty() && change.previous_sha256.is_none()
                                && change.after == "OBSOLETE-LOCAL-PROPOSAL"
                                && change.sha256 == crate::agent_tools::digest(b"OBSOLETE-LOCAL-PROPOSAL")) {
                            return Err("initial_proposal_not_exact");
                        }
                        return Ok(view);
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }).await.map_err(|_| "initial_approval_timeout")??;
            if !before.hello.as_ref().is_some_and(|hello| hello.supports_steering)
                || before.engine != WorkEngine::Thin || before.model != model {
                return Err("real_pi_steering_unavailable".into());
            }
            let request = uuid::Uuid::new_v4().to_string();
            let text = format!(" obsolete.txtの書込を取り下げ、answer.txtへ文字列\"{marker}\"だけをexactに書いてください。引用符、余分な空白や改行を加えず、承認を要求してください。他のファイルへの操作や実行は禁止です。 ");
            let receipt = service.steer_selected(&started.id, &request, &text,
                || Some(root.clone()), Duration::from_secs(10)).await?;
            let after = service.status(&started.id).ok_or("owned_run_missing")?;
            let unchanged = after.id == before.id && after.started_at_ms == before.started_at_ms
                && after.workspace == before.workspace && after.script == before.script
                && after.model == before.model && after.engine == before.engine
                && after.prompt == before.prompt && after.status == "running"
                && !after.allow_write && !after.allow_exec && !after.allow_http && !after.allow_test
                && serde_json::to_value(&after.pending_actions).unwrap() == serde_json::to_value(&before.pending_actions).unwrap();
            if !unchanged || !receipt.accepted || receipt.run_id != started.id || receipt.request_id != request
                || !steer_uuid(&receipt.delivery_id) || !steer_uuid(&receipt.user_message_id)
                || after.instructions.len() != 1 || after.instructions[0].text != text
                || after.instructions[0].request_id != request
                || after.instructions[0].delivery_id != receipt.delivery_id
                || after.instructions[0].user_message_id != receipt.user_message_id
                || !service.run(&started.id).ok_or("owned_run_missing")?.decisions.lock().unwrap()
                    .contains_key(&before.pending_actions[0].id) {
                return Err("steering_ack_or_approval_boundary_changed".into());
            }
            service.decide(&started.id, &before.pending_actions[0].id, false, None)?;
            let done = tokio::time::timeout(Duration::from_secs(120), async {
                let mut approvals = 0usize;
                loop {
                    let view = service.status(&started.id).ok_or("owned_run_missing")?;
                    if view.status != "running" { return Ok::<_, String>((view, approvals)); }
                    for action in view.pending_actions {
                        let change = serde_json::from_value::<crate::agent_tools::Change>(action.detail);
                        let approve = action.tool == "hub_write" && approvals == 0
                            && !root.join("obsolete.txt").exists() && !root.join("answer.txt").exists()
                            && change.is_ok_and(|change| change.path == "answer.txt"
                                && change.previous_sha256.is_none() && change.before.is_empty()
                                && change.after == marker && change.sha256 == crate::agent_tools::digest(marker.as_bytes()));
                        service.decide(&started.id, &action.id, approve, None)?;
                        if !approve { return Err("unexpected_followup_proposal_declined".into()); }
                        approvals += 1;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }).await.map_err(|_| "followup_terminal_timeout")??;
            // Join only this owned wait task so final checkpoint/history and lease release have finished.
            let wait = service.run(&started.id).ok_or("owned_run_missing")?.wait.lock().unwrap().take();
            if let Some(mut wait) = wait {
                match tokio::time::timeout(Duration::from_secs(10), &mut wait).await {
                    Ok(joined) => joined.map_err(|_| "owned_wait_failed")?,
                    Err(_) => { wait.abort(); let _ = wait.await; return Err("owned_wait_timeout".into()); }
                }
            }
            if done.0.id != started.id || done.0.status != "done" || done.1 != 1
                || !done.0.outcome.as_ref().is_some_and(|outcome| outcome.ok)
                || done.0.tool_calls.iter().filter(|call| call.name == "hub_write"
                    && call.detail.as_deref() == Some("answer.txt") && call.ok == Some(true)).count() != 1
                || root.join("obsolete.txt").exists()
                || std::fs::read_to_string(root.join("keep.txt")).map_err(|_| "original_unavailable")? != original
                || std::fs::read_to_string(root.join("answer.txt")).map_err(|_| "answer_unavailable")? != marker {
                return Err("independent_same_run_file_evidence_failed".into());
            }
            let saved = store.load::<PiCheckpoint>(&started.id).ok_or("encrypted_context_unavailable")?;
            if saved.workspace != root || context_engine(&saved.entries) != Some(WorkEngine::Thin)
                || !saved.entries.to_string().contains(&marker)
                || !saved.run.as_ref().is_some_and(|run| run.instructions.len() == 1
                    && run.instructions[0].text == text && run.instructions[0].delivery_id == receipt.delivery_id
                    && run.instructions[0].user_message_id == receipt.user_message_id) {
                return Err("encrypted_steering_context_missing".into());
            }
            let encrypted = std::fs::read(root.join("saved").join(format!("{}.jkcp", started.id)))
                .map_err(|_| "encrypted_file_unavailable")?;
            if String::from_utf8_lossy(&encrypted).contains(&marker)
                || std::fs::read_to_string(&history).map_err(|_| "history_unavailable")?.contains(&marker) {
                return Err("steering_body_leaked_to_plaintext".into());
            }
            let mut leases = leases.lock().await;
            leases.reserve_work(&root, "fixture-finished").map_err(|_| "owned_lease_not_released")?;
            leases.release_work(&root, "fixture-finished");
            Ok(())
        }.await;
        // Cleanup precedes the assertion: a failed acceptance cannot retain its own model process or lease.
        let cleanup = tokio::time::timeout(Duration::from_secs(10), service.cancel(&started.id, &leases)).await;
        assert!(cleanup.is_ok_and(|result| result.is_ok()), "owned fixture cleanup failed");
        assert!(result.is_ok(), "local same-run steering acceptance failed: {:?}", result.err());
    }


    #[tokio::test]
    #[ignore = "explicit local-only acceptance: PI_WORK_MODEL=ollama/...; real Pi and DSH comparison"]
    async fn formal_local_comparison_preserves_profile_and_only_approved_file() {
        let _env = crate::local_cli::ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let engines = match std::env::var("PI_WORK_COMPARISON_ENGINE") {
            Err(std::env::VarError::NotPresent) => vec![WorkEngine::Thin,WorkEngine::Dsh],
            Ok(value) if value == "thin" => vec![WorkEngine::Thin],
            Ok(value) if value == "dsh" => vec![WorkEngine::Dsh],
            _ => panic!("comparison_diagnostic_selector_invalid"),
        };
        let pair = engines.len() == 2;
        let model = std::env::var("PI_WORK_MODEL").expect("explicit local PI_WORK_MODEL required");
        validate_comparison_model(&model).expect("only an exact explicit local Ollama model is authorized");
        for name in ["PI_WORK_SIDECAR", "PI_POC_SCENARIO"] {
            assert!(std::env::var_os(name).is_none(), "sidecar or SDK stub override is forbidden");
        }
        let vendored = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/pi-sidecar/pi-sidecar.mjs");
        assert_eq!(resolve_script(None).unwrap(), non_verbatim(vendored.canonicalize().unwrap()));
        struct AgentDirRestore(Option<std::ffi::OsString>);
        impl Drop for AgentDirRestore {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
                    None => std::env::remove_var("PI_CODING_AGENT_DIR"),
                }
            }
        }
        let _agent_dir = AgentDirRestore(std::env::var_os("PI_CODING_AGENT_DIR"));
        let marker = format!("LOCAL-COMPARISON-{}", uuid::Uuid::new_v4());
        let keep = "UNRELATED-COMPARISON-FILE";
        let prompt = "Use hub_read to read input.txt. Propose creating answer.txt containing exactly its complete contents, with no additional whitespace or newline, and request approval. Do not edit input.txt or keep.txt, touch other files, run commands, or make HTTP requests.";
        let profile = GenerationProfile { temperature:0.0, max_tokens:1024, reasoning:GenerationReasoning::Off };
        let mut observed = Vec::new();
        for engine in engines {
            let (_guard, root) = temp_workspace();
            std::fs::write(root.join("input.txt"), &marker).unwrap();
            std::fs::write(root.join("keep.txt"), keep).unwrap();
            std::env::set_var("PI_CODING_AGENT_DIR", non_verbatim(root.join("agent-dir")));
            let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [31;32]);
            let history = root.join("history.jsonl");
            let service = PiWorkService { checkpoints:Some(store.clone()),history:Some(history.clone()),..Default::default() };
            let leases = leases();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
            // The same official helper and admission checks as the main-only command; no start-core bypass.
            let started = launch_comparison(&service,&leases,root.clone(),prompt,&model,engine,
                profile.clone(),true,Some(root.clone())).await.unwrap();
            let result: Result<PiRunState,String> = async {
                if started.generation != Some(profile.clone()) || started.engine != engine || started.model != model
                    || started.allow_write || started.allow_exec || started.allow_http || started.allow_test
                    || started.continuation.resumed_from.is_some() {
                    return Err("formal_comparison_start_changed_conditions".into());
                }
                let (done, approvals) = tokio::time::timeout_at(deadline, async {
                    let mut approvals = 0usize;
                    loop {
                        let view = service.status(&started.id).ok_or("owned_comparison_missing")?;
                        if view.status != "running" { return Ok::<_,String>((view,approvals)); }
                        for action in view.pending_actions {
                            let effective_profile = view.hello.as_ref().is_some_and(|hello| hello.generation == Some(profile.clone()));
                            let effective_model = view.hello.as_ref().is_some_and(|hello| hello.model.as_deref() == Some(model.as_str()));
                            let change = serde_json::from_value::<crate::agent_tools::Change>(action.detail);
                            let tool_hub_write = action.tool == "hub_write";
                            let answer_exists = root.join("answer.txt").exists();
                            let path_expected = change.as_ref().is_ok_and(|change| change.path == "answer.txt");
                            let before_empty = change.as_ref().is_ok_and(|change| change.before.is_empty());
                            let previous_none = change.as_ref().is_ok_and(|change| change.previous_sha256.is_none());
                            let after_exact = change.as_ref().is_ok_and(|change| change.after == marker);
                            let sha_match = change.as_ref().is_ok_and(|change| change.sha256 == crate::agent_tools::digest(marker.as_bytes()));
                            let approve = effective_profile && effective_model && approvals == 0 && tool_hub_write
                                && !answer_exists && path_expected && before_empty && previous_none && after_exact && sha_match;
                            service.decide(&started.id,&action.id,approve,None)?;
                            if !approve {
                                return Err(format!("comparison_proposal_or_effective_profile_rejected:effectiveProfile={effective_profile},effectiveModel={effective_model},approvals={approvals},toolHubWrite={tool_hub_write},pathExpected={path_expected},beforeEmpty={before_empty},previousNone={previous_none},afterExact={after_exact},shaMatch={sha_match},answerExists={answer_exists}"));
                            }
                            approvals += 1;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }).await.map_err(|_| "owned_comparison_180s_deadline")??;
                let wait = service.run(&started.id).ok_or("owned_comparison_missing")?.wait.lock().unwrap().take();
                if let Some(mut wait) = wait {
                    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now()).min(Duration::from_secs(10));
                    match tokio::time::timeout(remaining,&mut wait).await {
                        Ok(joined) => joined.map_err(|_| "owned_comparison_wait_failed")?,
                        Err(_) => { wait.abort(); let _ = wait.await; return Err("owned_comparison_wait_timeout".into()); }
                    }
                }
                if done.status != "done" || approvals != 1 || !done.outcome.as_ref().is_some_and(|outcome| outcome.ok)
                    || done.id != started.id || done.engine != engine || done.model != model
                    || done.generation != Some(profile.clone())
                    || !done.hello.as_ref().is_some_and(|hello| hello.generation == Some(profile.clone()))
                    || done.allow_write || done.allow_exec || done.allow_http || done.allow_test
                    || !done.tool_calls.iter().any(|call| call.name == "hub_read" && call.ok == Some(true)
                        && call.detail.as_deref() == Some("input.txt") && call.preview.as_deref() == Some(marker.as_str())) {
                    return Err("comparison_actual_result_or_conditions_failed".into());
                }
                for (path,expected) in [("answer.txt",marker.as_str()),("input.txt",marker.as_str()),("keep.txt",keep)] {
                    if std::fs::read_to_string(root.join(path)).map_err(|_| "comparison_file_unavailable")? != expected {
                        return Err("comparison_independent_file_evidence_failed".into());
                    }
                }
                let checkpoint = store.load::<PiCheckpoint>(&started.id).ok_or("comparison_checkpoint_unavailable")?;
                if checkpoint.workspace != root || context_engine(&checkpoint.entries) != Some(engine)
                    || !checkpoint.entries.to_string().contains(&marker)
                    || !checkpoint.run.as_ref().is_some_and(|run| run.generation == Some(profile.clone()) && run.engine == engine) {
                    return Err("comparison_authenticated_context_failed".into());
                }
                let ciphertext = std::fs::read(root.join("saved").join(format!("{}.jkcp",started.id)))
                    .map_err(|_| "comparison_ciphertext_unavailable")?;
                if String::from_utf8_lossy(&ciphertext).contains(&marker)
                    || std::fs::read_to_string(&history).map_err(|_| "comparison_history_unavailable")?.contains(&marker) {
                    return Err("comparison_plaintext_body_leak".into());
                }
                let mut leases = leases.lock().await;
                leases.reserve_work(&root,"comparison-finished").map_err(|_| "comparison_lease_retained")?;
                leases.release_work(&root,"comparison-finished");
                Ok(done)
            }.await;
            let cleanup = tokio::time::timeout(Duration::from_secs(10),service.cancel(&started.id,&leases)).await;
            assert!(cleanup.is_ok_and(|result| result.is_ok()),"owned comparison cleanup failed");
            assert!(result.is_ok(),"local {:?} comparison acceptance failed: {:?}",engine,result.as_ref().err());
            observed.push(result.unwrap());
        }
        assert_eq!(observed.len(),if pair { 2 } else { 1 });
        if pair {
            assert_eq!(observed[0].model,observed[1].model);
            assert_eq!(observed[0].generation,observed[1].generation);
            assert_eq!(observed[0].prompt,observed[1].prompt);
            assert_ne!(observed[0].workspace,observed[1].workspace);
        }
        // This is functional evidence; no elapsed-time comparison or superiority claim.
    }


    async fn local_resume_terminal(service: &PiWorkService,
        leases: &Arc<AsyncMutex<DevRuns>>, id: &str, root: &Path,
        expected: Option<&str>) -> (PiRunState, usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        let mut approvals = 0;
        loop {
            let view = service.status(id).expect("owned fixture run exists");
            if view.status != "running" { return (view, approvals); }
            if tokio::time::Instant::now() >= deadline {
                service.cancel(id, leases).await.expect("cancel only owned fixture run");
                let stopped = terminal(service, id).await;
                assert_eq!(stopped.status, "cancelled", "owned timeout run not cancelled");
                panic!("local resume acceptance exceeded 120 seconds; owned run cancelled");
            }
            for action in view.pending_actions {
                let change = serde_json::from_value::<crate::agent_tools::Change>(action.detail);
                let approve = expected.is_some_and(|marker| action.tool == "hub_write"
                    && approvals == 0 && !root.join("answer.txt").exists()
                    && change.as_ref().is_ok_and(|change| change.path == "answer.txt"
                        && change.previous_sha256.is_none() && change.before.is_empty()
                        && change.after == marker
                        && change.sha256 == crate::agent_tools::digest(marker.as_bytes())));
                // All unknown tools, paths, previews and further writes are declined.
                if service.decide(id, &action.id, approve, None).is_err() {
                    if service.status(id).is_some_and(|state| state.status == "running") {
                        service.cancel(id, leases).await.expect("cancel only owned fixture run");
                    }
                    let stopped = terminal(service, id).await;
                    assert_ne!(stopped.status, "running");
                    panic!("owned fixture decision failed; no live fixture run retained");
                }
                approvals += usize::from(approve);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    #[ignore = "requires node and the rebuilt vendored DSH SDK; no model or credentials"]
    async fn vendored_dsh_session_resumes_encrypted_context_with_fresh_permissions() {
        session_resume_acceptance("dsh").await;
    }

    #[tokio::test]
    #[ignore = "runs the vendored SDK and local Node, without provider inference"]
    async fn vendored_required_verification_runs_declared_command_and_obeys_actual_exit() {
        let _env = crate::local_cli::ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for engine in ["thin", "dsh"] {
            // The declared command needs no per-call approval; a failing one
            // gets bounded automatic repair rounds and never passes.
            for (exit, expected, rounds) in [
                (0, "passed", 1),
                (1, "failed", crate::verification::MAX_AUTO_ROUNDS),
            ] {
                let (_guard, root) = temp_workspace();
                std::fs::write(root.join("notes.txt"), "42").unwrap();
                let service = PiWorkService::default();
                let leases = leases();
                let command = serde_json::from_value(
                    json!({"program":"node","args":["-e",format!("process.exit({exit})")]}),
                )
                .unwrap();
                let started = service
                    .start_with_resume(
                        SidecarSpec {
                            program: "node".into(),
                            args: vec![resolve_script(None)
                                .unwrap()
                                .to_string_lossy()
                                .into_owned()],
                            workspace: root.clone(),
                            env: vec![
                                ("PI_WORK_ENGINE".into(), engine.into()),
                                ("PI_SIDECAR_SESSION".into(), "1".into()),
                                ("PI_SIDECAR_CAPS".into(), "exec".into()),
                                ("PI_POC_SCENARIO".into(), "read".into()),
                                (
                                    "PI_CODING_AGENT_DIR".into(),
                                    non_verbatim(root.join("agent-dir"))
                                        .to_string_lossy()
                                        .into_owned(),
                                ),
                            ],
                        },
                        "stub/stub-1".into(),
                        "Read notes".into(),
                        false,
                        true,
                        false,
                        false,
                        None,
                        &leases,
                        Some(command),
                    )
                    .await
                    .unwrap();
                let mut view = started;
                let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
                while view.status == "running" && tokio::time::Instant::now() < deadline {
                    assert!(view.pending_actions.is_empty(), "{engine}: declared command parked");
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    view = service.status(&view.id).unwrap();
                }
                assert_eq!(
                    view.status,
                    if expected == "passed" { "done" } else { "failed" },
                    "{engine}: {}",
                    view.stderr_tail
                );
                let check = view.verification.unwrap();
                assert_eq!(check.status, expected);
                // The stub repeats one read per repair, so the repeat guard may end
                // the run before the cap; it must still repair and never exceed it.
                assert_eq!(check.limit, Some(crate::verification::MAX_AUTO_ROUNDS));
                assert!((rounds == 1 && check.attempts == 1) || (2..=rounds).contains(&check.attempts), "{engine}: {} rounds", check.attempts);
                assert_eq!(view.outcome.unwrap().verified, expected == "passed");
            }
        }
    }

    #[tokio::test]
    async fn a_sidecar_cannot_claim_success_without_required_verification() {
        let (_guard, root) = temp_workspace();
        let script = root.join("claim.mjs");
        std::fs::write(&script, "process.stdin.once('data',()=>{console.log(JSON.stringify({type:'hello',proto:1,activeTools:[]}));console.log(JSON.stringify({type:'agent_done',ok:true}));process.stdin.destroy();});").unwrap();
        let service = PiWorkService::default();
        let leases = leases();
        let command =
            serde_json::from_value(json!({"program":"node","args":["verify.cjs"]})).unwrap();
        let spec = SidecarSpec {
            program: "node".into(),
            args: vec![non_verbatim(script).to_string_lossy().into_owned()],
            workspace: root,
            env: vec![("PI_SIDECAR_SESSION".into(), "1".into()), ("PI_WORK_ENGINE".into(), "thin".into())],
        };
        let started = service
            .start_with_resume(
                spec,
                "stub".into(),
                "x".into(),
                false,
                true,
                false,
                false,
                None,
                &leases,
                Some(command),
            )
            .await
            .unwrap();
        let view = terminal(&service, &started.id).await;
        assert_eq!(view.status, "failed");
        assert_eq!(view.verification.unwrap().status, "pending");
        let outcome = view.outcome.unwrap();
        assert!(!outcome.verified, "a sidecar's ok claim is not a verification record");
        assert_eq!(outcome.error.as_deref(), Some("required_verification_not_passed"));
    }

    /// "AIの接続": the key stays in the run's proxy. The sidecar's argv and environment carry only
    /// the proxy URL and run token, the run record, JSONL history and encrypted checkpoint (raw
    /// and decrypted) carry neither the key nor the token, and the proxy stops with the run.
    #[tokio::test]
    async fn byok_key_never_reaches_the_sidecar_or_persisted_run_data_and_the_proxy_dies_with_the_run() {
        const KEY: &str = "sk-ant-fixture-BYOK-SECRET-0123456789";
        let (_guard, root) = temp_workspace();
        std::fs::write(root.join("secret.txt"), "TOP-SECRET-42\n").unwrap();
        let settings = root.join("ai-connections.json");
        let keys = crate::byok::store::MemKeys::new();
        let id = crate::byok::store::save(&settings, &keys, crate::byok::store::SaveInput {
            id: None, kind: crate::byok::store::Kind::Anthropic, name: "hub-bench".into(), base_url: None,
            default_model: Some("claude-haiku-5-5".into()), enabled: Some(true), api_key: Some(KEY.into()),
        }).unwrap().id;
        let connection = crate::byok::pi::start(
            crate::byok::pi::resolve(&format!("byok:{id}/"), &settings, &keys).unwrap()).unwrap();
        let proxy_addr = connection.proxy.addr();
        let token = connection.proxy.token().to_owned();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [9; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService { checkpoints: Some(store.clone()), history: Some(history.clone()), ..PiWorkService::default() };
        let leases = leases();
        let mut env = connection.env.clone();
        env.extend([
            ("PI_POC_SCENARIO".to_owned(), "read".to_owned()),
            ("PI_WORK_ENGINE".into(), "thin".into()),
            ("PI_SIDECAR_SESSION".into(), "1".into()),
            ("PI_SIDECAR_CAPS".into(), "".into()),
            ("PI_SIDECAR_CWD".into(), non_verbatim(root.clone()).to_string_lossy().into_owned()),
            ("PI_CODING_AGENT_DIR".into(), non_verbatim(root.join("agent-dir")).to_string_lossy().into_owned()),
        ]);
        let spec = SidecarSpec {
            program: "node".into(),
            // Stub inference (no model argument): nothing leaves this machine in the test.
            args: vec![resolve_script(None).unwrap().to_string_lossy().into_owned()],
            workspace: root.clone(),
            env,
        };
        assert!(!format!("{:?}{:?}", spec.args, spec.env).contains(KEY), "the sidecar's argv and environment never hold the key");
        let started = service
            .start_core_proxied(spec, connection.reference.clone(), "Read".into(),
                false, false, false, false, None, &leases, None, None, None, None, Some(connection.proxy), Vec::new(), None)
            .await
            .unwrap();
        let done = terminal(&service, &started.id).await;
        assert_eq!(done.status, "done", "{}", done.stderr_tail);
        for secret in [KEY, token.as_str()] {
            assert!(!serde_json::to_string(&done).unwrap().contains(secret));
            assert!(!std::fs::read_to_string(&history).unwrap().contains(secret));
            assert!(!done.stderr_tail.contains(secret));
            for entry in std::fs::read_dir(root.join("saved")).unwrap() {
                assert!(!String::from_utf8_lossy(&std::fs::read(entry.unwrap().path()).unwrap()).contains(secret));
            }
            let checkpoint = store.load::<PiCheckpoint>(&started.id).unwrap();
            assert!(!serde_json::to_string(&checkpoint).unwrap().contains(secret));
        }
        let mut closed = false;
        for _ in 0..100 {
            if tokio::net::TcpStream::connect(proxy_addr).await.is_err() { closed = true; break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(closed, "the run's proxy stops when the run ends");
    }

    /// The paired Hub panel (HTTP) cannot start a run on the owner's API key.
    #[tokio::test]
    async fn byok_connections_are_refused_from_the_paired_panel() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let error = launch(&service, &leases(), root, "fix it", Some("byok:0f8c2a2e-5b1d-4c3e-9a7b-1234567890ab/m"),
            None, false, false, false, None, WorkEngine::Thin, None, Vec::new(), None).await.unwrap_err();
        assert_eq!(error, "byok_remote_not_allowed");
    }

    async fn session_resume_acceptance(engine: &str) {
        let (_guard, root) = temp_workspace();
        std::fs::write(root.join("secret.txt"), "TOP-SECRET-42\n").unwrap();
        std::fs::create_dir_all(root.join(".pi/extensions")).unwrap();
        std::fs::write(root.join(".pi/extensions/trap.ts"),
            "import{writeFileSync}from'node:fs';export default()=>writeFileSync('extension-executed','unexpected');").unwrap();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [8; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService {
            checkpoints: Some(store.clone()),
            history: Some(history.clone()),
            ..PiWorkService::default()
        };
        let leases = leases();
        let spec = |scenario: &str| SidecarSpec {
            program: "node".into(),
            args: vec![resolve_script(None).unwrap().to_string_lossy().into_owned()],
            workspace: root.clone(),
            env: vec![
                ("PI_POC_SCENARIO".into(), scenario.into()),
                ("PI_WORK_ENGINE".into(), engine.into()),
                ("PI_SIDECAR_SESSION".into(), "1".into()),
                ("PI_SIDECAR_CAPS".into(), "".into()),
                (
                    "PI_SIDECAR_CWD".into(),
                    non_verbatim(root.clone()).to_string_lossy().into_owned(),
                ),
                (
                    "PI_CODING_AGENT_DIR".into(),
                    non_verbatim(root.join("agent-dir"))
                        .to_string_lossy()
                        .into_owned(),
                ),
            ],
        };
        let first = service
            .start_with_resume(
                spec("read"),
                "stub/stub-1".into(),
                "Remember the fixture".into(),
                true,
                true,
                true,
                false,
                None,
                &leases,
                None,
            )
            .await
            .unwrap();
        let first = terminal(&service, &first.id).await;
        assert_eq!(first.status, "done", "{}", first.stderr_tail);
        assert!(first.final_output.contains("TOP-SECRET-42"));
        assert!(first.continuation.available, "{:?}", first.continuation);
        assert!(!root.join("extension-executed").exists());
        assert!(!std::fs::read_to_string(&history)
            .unwrap()
            .contains("TOP-SECRET"));
        let encrypted =
            std::fs::read(root.join("saved").join(format!("{}.jkcp", first.id))).unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains("TOP-SECRET"));
        // A fresh service represents a desktop restart. History is display data;
        // only the authenticated checkpoint can supply the conversation.
        let restored = PiWorkService {
            checkpoints: Some(store),
            history: Some(history),
            ..PiWorkService::default()
        };
        restored.restore_history();
        let mut wrong_engine = spec("resume");
        wrong_engine.env.retain(|(key, _)| key != "PI_WORK_ENGINE");
        wrong_engine.env.push((
            "PI_WORK_ENGINE".into(),
            if engine == "thin" { "dsh" } else { "thin" }.into(),
        ));
        assert_eq!(
            restored
                .start_with_resume(
                    wrong_engine,
                    "stub/stub-1".into(),
                    "Continue".into(),
                    false,
                    false,
                    false,
                    false,
                    Some(&first.id),
                    &leases,
                    None
                )
                .await
                .unwrap_err(),
            "pi_session_engine_mismatch"
        );
        assert_eq!(
            restored.status(&first.id).unwrap().final_output,
            first.final_output
        );
        // Changed on disk after the first run's read: that observation must not
        // carry over, so the interrupted run's first edit needs a fresh read.
        std::fs::write(root.join("secret.txt"), "TOP-SECRET-42\nchanged\n").unwrap();
        let interrupted = restored
            .start_with_resume(
                spec("resume"),
                "stub/stub-1".into(),
                "Continue".into(),
                false,
                false,
                false,
                false,
                Some(&first.id),
                &leases,
                None,
            )
            .await
            .unwrap();
        let mut pending = None;
        for _ in 0..400 {
            let view = restored.status(&interrupted.id).unwrap();
            if let Some(action) = view.pending_actions.first() {
                pending = Some(action.id.clone());
                break;
            }
            assert_eq!(view.status, "running", "{}", view.stderr_tail);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let pending = pending.expect("resumed edit waits for fresh approval");
        let cancelled = restored.cancel(&interrupted.id, &leases).await.unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.pending_actions.is_empty());
        assert!(cancelled.continuation.available);
        assert!(restored
            .decide(&cancelled.id, &pending, true, None)
            .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("secret.txt")).unwrap(),
            "TOP-SECRET-42\nchanged\n"
        );
        assert_eq!(
            cancelled.tool_calls.iter().map(|call| call.ok).collect::<Vec<_>>(),
            vec![Some(false), Some(true), None],
            "the changed file's old observation was refused"
        );
        let resumed = restored
            .start_with_resume(
                spec("resume"),
                "stub/stub-1".into(),
                "Continue".into(),
                false,
                false,
                false,
                false,
                Some(&cancelled.id),
                &leases,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            resumed.continuation.resumed_from.as_deref(),
            Some(cancelled.id.as_str())
        );
        assert!(!resumed.allow_write && !resumed.allow_exec && !resumed.allow_http);
        let mut decisions = 0;
        for _ in 0..400 {
            let view = restored.status(&resumed.id).unwrap();
            if view.status != "running" {
                break;
            }
            for action in view.pending_actions {
                assert_eq!(action.tool, "hub_edit");
                // The interrupted run's fresh read is unchanged on disk, so it
                // still counts; the edit still parks for a fresh approval.
                assert_eq!(action.detail["before"], "TOP-SECRET-42\nchanged\n");
                assert_eq!(action.detail["after"], "TOP-SECRET-43\nchanged\n");
                restored
                    .decide(&resumed.id, &action.id, true, None)
                    .unwrap();
                decisions += 1;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let done = terminal(&restored, &resumed.id).await;
        assert_eq!(done.status, "done", "{}", done.stderr_tail);
        assert_eq!(
            decisions, 1,
            "the edit of the unchanged, earlier-read file asks for approval once"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("secret.txt")).unwrap(),
            "TOP-SECRET-43\nchanged\n"
        );
        assert_eq!(
            done.tool_calls
                .iter()
                .map(|call| call.ok)
                .collect::<Vec<_>>(),
            vec![Some(true)]
        );
        assert!(!done
            .hello
            .unwrap()
            .active_tools
            .iter()
            .any(|name| name == "hub_exec"));
        assert!(done.continuation.available);
        assert_eq!(done.final_output, "resume verified");
        assert!(!root.join("extension-executed").exists());
    }

    /// 2026-10-18: a thin run resumes from its encrypted checkpoint after a cancel (here while
    /// its first native write waited for approval) and a restart: same engine only, fresh
    /// permissions, the interrupted write becomes an unknown outcome and is never re-run, and
    /// neither the BYOK key nor the run's proxy token reaches the checkpoint or history.
    #[tokio::test]
    async fn thin_session_resumes_after_cancel_with_fresh_permissions_and_no_key() {
        const KEY: &str = "sk-ant-fixture-THIN-RESUME-0123456789";
        let (_guard, root) = temp_workspace();
        let settings = root.join("ai-connections.json");
        let keys = crate::byok::store::MemKeys::new();
        let id = crate::byok::store::save(&settings, &keys, crate::byok::store::SaveInput {
            id: None, kind: crate::byok::store::Kind::Anthropic, name: "hub-thin".into(), base_url: None,
            default_model: Some("claude-haiku-5-5".into()), enabled: Some(true), api_key: Some(KEY.into()),
        }).unwrap().id;
        let connection = crate::byok::pi::start(
            crate::byok::pi::resolve(&format!("byok:{id}/"), &settings, &keys).unwrap()).unwrap();
        let token = connection.proxy.token().to_owned();
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [31; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService { checkpoints: Some(store.clone()), history: Some(history.clone()), ..PiWorkService::default() };
        let leases = leases();
        let spec = |engine: &str, extra: Vec<(String, String)>| SidecarSpec {
            program: "node".into(),
            // Stub inference (no model argument): nothing leaves this machine in the test.
            args: vec![resolve_script(None).unwrap().to_string_lossy().into_owned()],
            workspace: root.clone(),
            env: extra.into_iter().chain([
                ("PI_POC_SCENARIO".to_owned(), "thin".to_owned()),
                ("PI_WORK_ENGINE".into(), engine.into()),
                ("PI_SIDECAR_SESSION".into(), "1".into()),
                ("PI_SIDECAR_CAPS".into(), "".into()),
                ("PI_SIDECAR_CWD".into(), non_verbatim(root.clone()).to_string_lossy().into_owned()),
                ("PI_CODING_AGENT_DIR".into(), non_verbatim(root.join("agent-dir")).to_string_lossy().into_owned()),
            ]).collect(),
        };
        let started = service
            .start_core_proxied(spec("thin", connection.env.clone()), connection.reference.clone(), "Thin".into(),
                false, false, false, false, None, &leases, None, None, None, None, Some(connection.proxy), Vec::new(), None)
            .await
            .unwrap();
        assert_eq!(started.engine, WorkEngine::Thin);
        let mut pending = None;
        for _ in 0..400 {
            let view = service.status(&started.id).unwrap();
            if let Some(action) = view.pending_actions.first() {
                pending = Some(action.clone());
                break;
            }
            assert_eq!(view.status, "running", "{}", view.stderr_tail);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let pending = pending.expect("the native write parks for approval");
        assert_eq!(pending.tool, "hub_write");
        let cancelled = service.cancel(&started.id, &leases).await.unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.continuation.available, "{:?}", cancelled.continuation);
        assert!(cancelled.continuation.error.is_none(), "{:?}", cancelled.continuation);
        assert!(service.decide(&cancelled.id, &pending.id, true, None).is_err(), "no approval outlives the run");
        assert!(!root.join("sub").exists());
        let checkpoint = store.load::<PiCheckpoint>(&started.id).unwrap();
        assert_eq!(context_engine(&checkpoint.entries), Some(WorkEngine::Thin));
        for secret in [KEY, token.as_str()] {
            assert!(!serde_json::to_string(&checkpoint).unwrap().contains(secret));
            assert!(!std::fs::read_to_string(&history).unwrap().contains(secret));
            for entry in std::fs::read_dir(root.join("saved")).unwrap() {
                assert!(!String::from_utf8_lossy(&std::fs::read(entry.unwrap().path()).unwrap()).contains(secret));
            }
        }

        // A fresh service is a desktop restart; only the authenticated checkpoint holds the talk.
        let restored = PiWorkService { checkpoints: Some(store), history: Some(history), ..PiWorkService::default() };
        restored.restore_history();
        assert_eq!(restored.saved_engine(Some(&started.id)), Some(WorkEngine::Thin), "a resume with no engine stays thin");
        assert_eq!(restored
            .start_with_resume(spec("dsh", Vec::new()), "stub/stub-1".into(), "Continue".into(),
                false, false, false, false, Some(&cancelled.id), &leases, None)
            .await
            .unwrap_err(), "pi_session_engine_mismatch");
        let resumed = restored
            .start_with_resume(spec("thin", Vec::new()), "stub/stub-1".into(), "Continue".into(),
                false, false, false, false, Some(&cancelled.id), &leases, None)
            .await
            .unwrap();
        assert_eq!(resumed.engine, WorkEngine::Thin);
        assert_eq!(resumed.continuation.resumed_from.as_deref(), Some(cancelled.id.as_str()));
        assert!(!resumed.allow_write && !resumed.allow_exec && !resumed.allow_http && !resumed.allow_test);
        let done = terminal(&restored, &resumed.id).await;
        assert_eq!(done.status, "done", "{}", done.stderr_tail);
        assert!(done.final_output.contains("thin done read:error,write:error,edit:error,bash:error,ls:ok"), "{}", done.final_output);
        assert!(done.final_output.contains("outcome unknown"), "{}", done.final_output);
        assert!(!root.join("sub").exists(), "the interrupted write was never re-run");
        assert!(done.continuation.available);
    }

    #[test]
    fn pi_work_commands_are_gated_to_bundled_ai_windows() {
        let source = include_str!("pi_work.rs");
        for command in [
            "pi_work_start",
            "pi_work_status",
            "pi_work_list",
            "pi_work_cancel",
            "pi_work_decide",
            "pi_work_models",
            "pi_work_detect_checkers",
            "pi_work_best_of_estimate",
        ] {
            let body = source
                .split(&format!("pub async fn {command}"))
                .nth(1)
                .expect("command body");
            let body = body.split("#[tauri::command]").next().unwrap_or(body);
            assert!(body.contains("window: tauri::Webview,"), "{command}");
            assert!(body.contains("native_pi(&window)?"), "{command}");
        }
    }

    struct ImageInitFixture {
        _directory: crate::agent_tools::TestWorkspace,
        root: PathBuf,
        other: PathBuf,
        service: PiWorkService,
        store: crate::checkpoint::CheckpointStore,
        leases: Arc<AsyncMutex<DevRuns>>,
        state: Arc<Mutex<PiRunState>>,
    }

    impl ImageInitFixture {
        async fn new() -> Self {
            let (directory, root) = temp_workspace();
            let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [61; 32]);
            let service = PiWorkService { checkpoints: Some(store.clone()), history: Some(root.join("runs.jsonl")), ..Default::default() };
            let id = uuid::Uuid::new_v4().to_string();
            let image_id = uuid::Uuid::new_v4().to_string();
            let mut state = running_state(&id, &root);
            state.workspace = non_verbatim(root.clone()).to_string_lossy().into_owned();
            state.image_context_refs = vec![crate::pi_images::ImageReference { id: image_id.clone(),
                mime_type: "image/png".into(), size_bytes: 69, sha256: "a".repeat(64) }];
            state.image_attachments = vec![crate::pi_images::ImageAttachment {
                r#type: crate::pi_images::ImageAttachmentKind::Image, id: image_id.clone(),
                name: "PRIVATE-INITIALIZATION-IMAGE.png".into(), mime_type: "image/png".into(), size_bytes: 69 }];
            state.prompt_image_ids = vec![image_id];
            state.image_request_id = Some(uuid::Uuid::new_v4().to_string());
            state.image_receipt_valid = false;
            let state = Arc::new(Mutex::new(state));
            let leases = leases();
            leases.lock().await.reserve_work(&root, &id).unwrap();
            let other = root.with_file_name(format!("unrelated-{}", uuid::Uuid::new_v4()));
            leases.lock().await.reserve_work(&other, "unrelated").unwrap();
            insert_run(&service, "unrelated", &other, Arc::new(Mutex::new(running_state("unrelated", &other))), Arc::new(Mutex::default()));
            Self { _directory: directory, root, other, service, store, leases, state }
        }

        fn guard(&self) -> PiInitializationGuard {
            let id = self.state.lock().unwrap().id.clone();
            let mut guard = PiInitializationGuard::new(&self.service, &self.leases, &self.root, &id);
            guard.retain_images(self.state.clone(), Arc::new(Mutex::new(PiChangeArchive::new())),
                Arc::new(Mutex::default()), watch::channel(0).0);
            guard
        }

        fn assert_saved_failure(&self, error: &str) {
            let expected = self.state.lock().unwrap().clone();
            let saved = self.store.load::<PiCheckpoint>(&expected.id).unwrap();
            assert_eq!(saved.workspace, self.root);
            assert!(saved.entries.is_null()); // no made-up SDK header or resumable context
            let state = saved.run.unwrap();
            assert_eq!(state.status, "failed");
            assert_eq!(state.outcome.unwrap().error.as_deref(), Some(error));
            assert!(!state.continuation.available);
            assert_eq!(state.image_context_refs, expected.image_context_refs);
            assert_eq!(state.image_request_id, expected.image_request_id);
            assert_eq!(state.prompt_image_ids, expected.prompt_image_ids);
            assert!(!state.image_receipt_valid);
            let run = self.service.run(&state.id).unwrap();
            assert_eq!(run.workspace, self.root);
            assert!(run.wait.lock().unwrap().is_none());
            assert!(run.steering.is_none());
            assert!(run.decisions.lock().unwrap().is_empty());
            assert!(self.service.resume_checkpoint(&state.id, &self.root).is_err());
            let plain = std::fs::read_to_string(self.root.join("runs.jsonl")).unwrap();
            assert_eq!(plain.lines().count(), 1);
            for private in [expected.image_request_id.unwrap(), expected.prompt_image_ids[0].clone(), "PRIVATE-INITIALIZATION-IMAGE.png".into()] {
                assert!(!plain.contains(&private));
            }
            assert_eq!(self.service.status("unrelated").unwrap().status, "running");
        }
    }

    #[tokio::test]
    async fn image_initialization_spawn_and_partial_send_failure_preserve_encrypted_owner_metadata() {
        // The real transport's failed/partial writes are tested in pi_sidecar;
        // drive their error seam here without starting Node, a model, or OS keys.
        for failure in ["synthetic spawn failure", "synthetic partial send failure"] {
            let fixture = ImageInitFixture::new().await;
            let mut guard = fixture.guard();
            assert_eq!(guard.failure(failure.into()), "pi_image_initialization_failed");
            drop(guard);
            fixture.assert_saved_failure("pi_image_initialization_failed");
            let mut leases = fixture.leases.lock().await;
            assert!(leases.reserve_work(&fixture.root, "replacement").is_ok());
            assert!(leases.reserve_work(&fixture.other, "other-replacement").is_err());
        }
    }

    #[tokio::test]
    async fn image_initialization_future_drop_preserves_unknown_metadata_and_releases_only_owned_lease() {
        let fixture = ImageInitFixture::new().await;
        let guard = fixture.guard();
        let (started, ready) = oneshot::channel();
        let future = tokio::spawn(async move {
            let _guard = guard;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        let held = fixture.leases.lock().await;
        future.abort();
        assert!(future.await.unwrap_err().is_cancelled());
        fixture.assert_saved_failure("pi_image_initialization_unknown");
        drop(held);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if fixture.leases.lock().await.reserve_work(&fixture.root, "replacement").is_ok() { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert!(fixture.leases.lock().await.reserve_work(&fixture.other, "other-replacement").is_err());
    }

    #[tokio::test]
    async fn image_initialization_success_handoff_does_not_fail_or_release_a_completed_run() {
        let fixture = ImageInitFixture::new().await;
        let mut guard = fixture.guard();
        fixture.state.lock().unwrap().status = "done".into();
        insert_run(&fixture.service, &fixture.state.lock().unwrap().id.clone(), &fixture.root,
            fixture.state.clone(), Arc::new(Mutex::default()));
        guard.disarm();
        drop(guard);
        assert_eq!(fixture.service.list().iter().find(|run| run.id != "unrelated").unwrap().status, "done");
        assert!(!fixture.root.join("runs.jsonl").exists());
        assert!(fixture.leases.lock().await.reserve_work(&fixture.root, "replacement").is_err());
    }

    fn running_state(id: &str, root: &std::path::Path) -> PiRunState {
        PiRunState {
            image_attachments: Vec::new(), image_context_refs: Vec::new(), prompt_image_ids: Vec::new(), reattached_image_ids: Vec::new(), image_request_id: None, image_receipt_valid: true,
            fast_check: None, best_of: None,
            generation: None, supports_steering: false, instructions: Vec::new(), changes: PiChangeSummary::default(),
            verification: None,
            engine: WorkEngine::Thin,
            usage: PiUsage::default(),
            final_output: String::new(),
            continuation: PiContinuation::default(),
            id: id.into(),
            workspace: root.to_string_lossy().into_owned(),
            script: "s".into(),
            model: "m".into(),
            prompt: "p".into(),
            allow_write: false,
            allow_exec: false,
            allow_http: false,
            allow_test: false,
            status: "running".into(),
            hello: None,
            tool_calls: vec![],
            pending_actions: vec![],
            agent_events: 0,
            partial_output: String::new(),
            outcome: None,
            stderr_tail: String::new(),
            started_at_ms: 0,
            ended_at_ms: None,
        }
    }

    /// Inserts a run record without a process so the decide/approver wiring
    /// can be driven directly; `wait: None` means cancel is a no-op on it.
    fn insert_run(
        service: &PiWorkService,
        id: &str,
        root: &std::path::Path,
        state: Arc<Mutex<PiRunState>>,
        decisions: Arc<Mutex<HashMap<String, oneshot::Sender<PiDecision>>>>,
    ) {
        let run = Arc::new(PiRun {
            steering: None, steering_checkpoint: None, steering_ledger: Mutex::new(SteeringLedger::default()), steering_gate: tokio::sync::Mutex::new(()), file_changes: Arc::new(Mutex::new(PiChangeArchive::default())),
            state,
            workspace: root.to_path_buf(),
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            decisions,
            wait: Mutex::new(None),
            recorded: Arc::new(AtomicBool::new(false)),
            changes: watch::channel(0).0,
        });
        let mut inner = service.inner.lock().unwrap();
        inner.order.push(id.to_string());
        inner.runs.insert(id.to_string(), run);
    }

    async fn pending_action(service: &PiWorkService, id: &str) -> PiPendingAction {
        for _ in 0..200 {
            if let Some(action) = service
                .status(id)
                .and_then(|state| state.pending_actions.into_iter().next())
            {
                return action;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no pending action published");
    }

    /// The full approval round trip without a child process: the approver
    /// publishes a `pendingActions` entry, `decide` resolves it once, and a
    /// deny returns false — the same wiring `start()` builds for a gated run.
    #[tokio::test]
    async fn decide_answers_a_pending_action_exactly_once() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        let decisions = Arc::new(Mutex::new(HashMap::new()));
        insert_run(&service, "r1", &root, state.clone(), decisions.clone());
        let approver = approver_for(state, decisions, service.run("r1").unwrap().changes.clone());

        let ask = tokio::spawn(approver(PiApprovalRequest {
            tool: "hub_write".into(),
            summary: "write a.txt (5 bytes)".into(),
            detail: serde_json::Value::Null,
        }));
        let pending = pending_action(&service, "r1").await;
        assert_eq!(pending.tool, "hub_write");
        assert_eq!(pending.summary, "write a.txt (5 bytes)");
        let view = service
            .decide("r1", &pending.id, true, None)
            .expect("decide");
        assert!(ask.await.expect("approver future").approved);
        assert!(view.pending_actions.is_empty());
        // One-shot: the same id cannot be decided twice.
        assert_eq!(
            service.decide("r1", &pending.id, false, None).unwrap_err(),
            "pi_action_not_found"
        );

        let ask = tokio::spawn(approver(PiApprovalRequest {
            tool: "hub_edit".into(),
            summary: "edit a.txt".into(),
            detail: serde_json::Value::Null,
        }));
        let pending = pending_action(&service, "r1").await;
        service
            .decide("r1", &pending.id, false, None)
            .expect("deny");
        assert!(!ask.await.expect("approver future").approved);
    }

    #[tokio::test]
    async fn decide_reports_unknown_runs_and_actions() {
        let service = PiWorkService::default();
        assert_eq!(
            service.decide("missing", "a1", true, None).unwrap_err(),
            "pi_work_not_found"
        );
        let (_guard, root) = temp_workspace();
        insert_run(
            &service,
            "r1",
            &root,
            Arc::new(Mutex::new(running_state("r1", &root))),
            Arc::new(Mutex::new(HashMap::new())),
        );
        assert_eq!(
            service.decide("r1", "missing", true, None).unwrap_err(),
            "pi_action_not_found"
        );
    }

    #[tokio::test]
    async fn decide_rejects_purchase_without_result_and_preserves_denial() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        let decisions = Arc::new(Mutex::new(HashMap::new()));
        insert_run(&service, "r1", &root, state.clone(), decisions.clone());
        let approver = approver_for(state, decisions, service.run("r1").unwrap().changes.clone());
        let ask = tokio::spawn(approver(PiApprovalRequest {
            tool: "hub_pay".into(), summary: "purchase".into(), detail: serde_json::Value::Null,
        }));
        let pending = pending_action(&service, "r1").await;
        for outcome in [None, Some(serde_json::Value::Null)] {
            assert_eq!(service.decide("r1", &pending.id, true, outcome).unwrap_err(), "purchase_execution_unavailable");
            assert_eq!(service.status("r1").unwrap().pending_actions.len(), 1);
            assert!(!ask.is_finished());
        }
        service.decide("r1", &pending.id, false, None).expect("denial remains available");
        assert!(!ask.await.expect("approver future").approved);
        assert!(service.status("r1").unwrap().pending_actions.is_empty());
    }

    #[tokio::test]
    async fn window_decide_accepts_only_the_matching_handoff_outcome() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        let decisions = Arc::new(Mutex::new(HashMap::new()));
        insert_run(&service, "r1", &root, state.clone(), decisions.clone());
        let approver = approver_for(state, decisions, service.run("r1").unwrap().changes.clone());
        let id = "8f14e45f-ceea-467a-9575-1f3b1c5a2d11";
        let ask = tokio::spawn(approver(PiApprovalRequest {
            tool: "hub_pay".into(), summary: "purchase".into(),
            detail: json!({ "productId": id, "quantity": 2 }),
        }));
        let pending = pending_action(&service, "r1").await;
        for bad in [
            json!({ "status": "paid", "productId": id, "quantity": 2 }),
            json!({ "status": "handed_to_checkout", "productId": id, "quantity": 3 }),
            json!({ "status": "handed_to_checkout", "productId": "other", "quantity": 2 }),
            json!({ "status": "handed_to_checkout", "productId": id, "quantity": 2, "ok": true }),
        ] {
            assert_eq!(service.decide_from_window("r1", &pending.id, true, Some(bad)).unwrap_err(), "purchase_outcome_invalid");
        }
        assert_eq!(service.decide_from_window("r1", &pending.id, false, Some(json!({ "status": "handed_to_checkout", "productId": id, "quantity": 2 }))).unwrap_err(), "purchase_outcome_invalid");
        assert_eq!(service.status("r1").unwrap().pending_actions.len(), 1);
        let good = json!({ "status": "handed_to_checkout", "productId": id, "quantity": 2 });
        service.decide_from_window("r1", &pending.id, true, Some(good.clone())).expect("handoff");
        let decision = ask.await.expect("approver future");
        assert!(decision.approved);
        assert_eq!(decision.outcome, Some(good));
    }

    /// The paired HTTP route uses the same restricted path: an outcome on any
    /// tool other than `hub_pay` is refused and the action stays pending.
    #[tokio::test]
    async fn window_decide_refuses_an_outcome_for_other_tools() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        let decisions = Arc::new(Mutex::new(HashMap::new()));
        insert_run(&service, "r1", &root, state.clone(), decisions.clone());
        let approver = approver_for(state, decisions, service.run("r1").unwrap().changes.clone());
        let ask = tokio::spawn(approver(PiApprovalRequest {
            tool: "hub_write".into(), summary: "write".into(),
            detail: json!({ "productId": "p", "quantity": 1 }),
        }));
        let pending = pending_action(&service, "r1").await;
        let forged = json!({ "status": "handed_to_checkout", "productId": "p", "quantity": 1 });
        assert_eq!(service.decide_from_window("r1", &pending.id, true, Some(forged)).unwrap_err(), "purchase_outcome_invalid");
        assert_eq!(service.status("r1").unwrap().pending_actions.len(), 1);
        service.decide_from_window("r1", &pending.id, false, None).expect("deny");
        assert!(!ask.await.expect("approver future").approved);
    }

    /// An oversized outcome is refused before the decision channel is
    /// consumed, so the pending action survives for a valid retry or a deny.
    #[tokio::test]
    async fn decide_rejects_an_oversized_outcome_without_consuming() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        let decisions = Arc::new(Mutex::new(HashMap::new()));
        insert_run(&service, "r1", &root, state.clone(), decisions.clone());
        let approver = approver_for(state, decisions, service.run("r1").unwrap().changes.clone());
        let ask = tokio::spawn(approver(PiApprovalRequest {
            tool: "hub_pay".into(),
            summary: "purchase".into(),
            detail: serde_json::Value::Null,
        }));
        let pending = pending_action(&service, "r1").await;
        let oversized = json!({ "order": "x".repeat(20_000) });
        assert_eq!(
            service
                .decide("r1", &pending.id, true, Some(oversized))
                .unwrap_err(),
            "outcome_too_large"
        );
        // Still parked: a bounded outcome resolves it.
        service
            .decide("r1", &pending.id, true, Some(json!({ "ok": true })))
            .expect("bounded outcome decides");
        let decision = ask.await.expect("approver future");
        assert!(decision.approved);
        assert_eq!(decision.outcome, Some(json!({ "ok": true })));
    }

    /// Every path that ends a decision wait fails closed: clearing the
    /// decisions map (what cancel and the wait task's terminal path do) drops
    /// the sender, the receiver errors, and the approver answers false.
    /// Terminal status and a full queue deny before anything is even queued.
    #[tokio::test]
    async fn approver_fails_closed_on_end_cap_and_terminal_status() {
        let (_guard, root) = temp_workspace();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        let decisions = Arc::new(Mutex::new(HashMap::new()));
        let approver = approver_for(state.clone(), decisions.clone(), watch::channel(0).0);

        let ask = tokio::spawn(approver(PiApprovalRequest {
            tool: "hub_write".into(),
            summary: "write a.txt (1 bytes)".into(),
            detail: serde_json::Value::Null,
        }));
        for _ in 0..200 {
            if !state.lock().unwrap().pending_actions.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        decisions.lock().unwrap().clear();
        assert!(!ask.await.expect("approver future").approved);
        // The guard removed the entry; nothing stale is left for the window.
        assert!(state.lock().unwrap().pending_actions.is_empty());

        state.lock().unwrap().status = "done".into();
        assert!(
            !approver(PiApprovalRequest {
                tool: "hub_edit".into(),
                summary: "edit a.txt".into(),
                detail: serde_json::Value::Null,
            })
            .await
            .approved
        );
        assert!(state.lock().unwrap().pending_actions.is_empty());

        {
            let mut state = state.lock().unwrap();
            state.status = "running".into();
            state.pending_actions = (0..MAX_PENDING_ACTIONS)
                .map(|i| PiPendingAction {
                    id: i.to_string(),
                    tool: "hub_write".into(),
                    summary: String::new(),
                    detail: serde_json::Value::Null,
                    proposed_at_ms: 0,
                })
                .collect();
        }
        assert!(
            !approver(PiApprovalRequest {
                tool: "hub_write".into(),
                summary: "w".into(),
                detail: serde_json::Value::Null,
            })
            .await
            .approved
        );
        assert_eq!(
            state.lock().unwrap().pending_actions.len(),
            MAX_PENDING_ACTIONS
        );
    }

    /// Streamed deltas append in order; past the cap only the newest chars
    /// survive — counted in chars, so a multibyte tail is not under-filled.
    #[test]
    fn partial_output_appends_and_caps_the_tail_in_chars() {
        let (_guard, root) = temp_workspace();
        let mut state = running_state("r1", &root);
        push_partial(&mut state, "答えは");
        push_partial(&mut state, "42");
        assert_eq!(state.partial_output, "答えは42");
        push_partial(&mut state, &"あ".repeat(MAX_PARTIAL_OUTPUT_CHARS + 5));
        assert_eq!(
            state.partial_output.chars().count(),
            MAX_PARTIAL_OUTPUT_CHARS
        );
        assert!(state.partial_output.ends_with('あ'));
    }

    /// Terminal bookkeeping drops the live tail together with parked
    /// approvals — both are in-flight display state.
    #[test]
    fn clear_transient_drops_partial_output_and_pending_actions() {
        let (_guard, root) = temp_workspace();
        let mut state = running_state("r1", &root);
        state.verification = Some(crate::verification::VerificationState {
            status: "running".into(),
            attempts: 1,
            limit: None,
        });
        state.partial_output = "streaming…".into();
        state.pending_actions.push(PiPendingAction {
            id: "pa_1".into(),
            tool: "hub_write".into(),
            summary: "write a.txt".into(),
            detail: serde_json::Value::Null,
            proposed_at_ms: 0,
        });
        clear_transient(&mut state);
        assert!(state.partial_output.is_empty());
        assert_eq!(state.verification.unwrap().status, "incomplete");
        assert!(state.pending_actions.is_empty());
    }

    /// Cancel is the process-free terminal path; its transition clears the
    /// tail the same way the wait task's terminal block does.
    #[tokio::test]
    async fn cancel_clears_partial_output() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let leases = leases();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        state.lock().unwrap().partial_output = "partial".into();
        insert_run(
            &service,
            "r1",
            &root,
            state,
            Arc::new(Mutex::new(HashMap::new())),
        );
        let view = service.cancel("r1", &leases).await.expect("cancel");
        assert_eq!(view.status, "cancelled");
        assert!(view.partial_output.is_empty());
    }

    /// `watch` is the long-poll the window drives: an unseen version answers
    /// at once, the current one waits out the deadline, and a mid-wait bump
    /// wakes it immediately.
    #[tokio::test]
    async fn watch_returns_on_version_change() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let state = Arc::new(Mutex::new(running_state("r1", &root)));
        insert_run(
            &service,
            "r1",
            &root,
            Arc::clone(&state),
            Arc::new(Mutex::new(HashMap::new())),
        );
        let watching = tokio::spawn({
            let service = service.clone();
            async move { service.watch("r1", Some(0), Duration::from_secs(10)).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        state.lock().unwrap().agent_events = 7;
        service
            .run("r1")
            .unwrap()
            .changes
            .send_modify(|version| *version += 1);
        let (version, view) = watching.await.unwrap().expect("run exists");
        assert!(version > 0);
        assert_eq!(view.agent_events, 7);
        // A stale `since` must not wait: the answer is already newer.
        let (version, _) = service.watch("r1", Some(0), Duration::ZERO).await.unwrap();
        assert!(version >= 1);
        // Deadline hit with no change still answers — body unchanged.
        let (version, view) = service
            .watch("r1", Some(version), Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(view.agent_events, 7);
        let _ = version;
    }

    #[test]
    fn legacy_todo_field_is_tolerated_and_dropped() {
        let (_guard, root) = temp_workspace();
        let state = running_state("r1", &root);
        let mut value = serde_json::to_value(&state).unwrap();
        assert!(value.get("todo").is_none());
        value["todo"] = json!([{"text": "a", "status": "done"}]);
        let restored: PiRunState = serde_json::from_value(value).unwrap();
        assert_eq!(restored.id, "r1");
        assert!(serde_json::to_value(&restored).unwrap().get("todo").is_none());
    }

    /// Real-process lifecycle: hello, one tool call, agent_done, exit.
    /// Requires `node` on PATH; run with `cargo test pi_work -- --ignored`.
    #[tokio::test]
    #[ignore = "requires node on PATH"]
    async fn run_lifecycle_reports_done_and_releases_the_lease() {
        let script = r#"
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'hello', proto: 1, activeTools: ['hub_list'], tools: [{ name: 'hub_list', description: 'd', parameters: { type: 'object' } }] });
send({ type: 'event', event: { type: 'agent_start' } });
setTimeout(() => send({ type: 'tool_call', id: 'tc_1', name: 'hub_list', args: { path: '' } }), 20);
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'tool_result' || msg.type === 'tool_error') {
    send({ type: 'agent_done', ok: msg.type === 'tool_result' });
    process.exit(0);
  }
});
"#;
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let leases = leases();
        let started = service
            .start(
                SidecarSpec {
                    program: PathBuf::from("node"),
                    args: vec!["-e".into(), script.into()],
                    workspace: root.clone(),
                    env: Vec::new(),
                },
                "m".into(),
                "p".into(),
                false,
                false,
                false,
                false,
                &leases,
            )
            .await
            .expect("start");
        assert_eq!(started.status, "running");
        // A second run on the same workspace is refused while the first lives.
        assert_eq!(
            service
                .start(
                    SidecarSpec {
                        program: PathBuf::from("node"),
                        args: vec!["-e".into(), "process.exit(0)".into()],
                        workspace: root.clone(),
                        env: Vec::new(),
                    },
                    "m".into(),
                    "p".into(),
                    false,
                    false,
                    false,
                    false,
                    &leases,
                )
                .await
                .unwrap_err(),
            "run already in progress"
        );
        let view = terminal(&service, &started.id).await;
        assert_eq!(view.status, "done");
        let outcome = view.outcome.as_ref().expect("outcome");
        assert!(outcome.ok);
        assert_eq!(outcome.exit_code, Some(0));
        let hello = view.hello.as_ref().expect("hello");
        assert_eq!(hello.proto, 1);
        assert_eq!(hello.active_tools, vec!["hub_list".to_string()]);
        assert_eq!(hello.tools[0].name, "hub_list");
        assert_eq!(view.agent_events, 1);
        assert_eq!(view.tool_calls.len(), 1);
        assert_eq!(view.tool_calls[0].name, "hub_list");
        assert_eq!(view.tool_calls[0].ok, Some(true));
        assert!(view.ended_at_ms.is_some());
        // The lease is free again once the run is done.
        leases
            .lock()
            .await
            .reserve_work(&root, "another")
            .expect("lease released");
    }

    /// Cancel aborts the wait task; the drop chain kills the child.
    #[tokio::test]
    #[ignore = "requires node on PATH"]
    async fn cancel_marks_the_run_and_releases_the_lease() {
        let script = r#"
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'hello', proto: 1, activeTools: [], tools: [] });
setInterval(() => {}, 1000);
"#;
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let leases = leases();
        let started = service
            .start(
                SidecarSpec {
                    program: PathBuf::from("node"),
                    args: vec!["-e".into(), script.into()],
                    workspace: root.clone(),
                    env: Vec::new(),
                },
                "m".into(),
                "p".into(),
                true,
                false,
                false,
                false,
                &leases,
            )
            .await
            .expect("start");
        assert!(started.allow_write);
        // Let the wait task actually enter session.wait() before cancelling.
        for _ in 0..200 {
            if service.status(&started.id).unwrap().hello.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let cancelled = service.cancel(&started.id, &leases).await.expect("cancel");
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.ended_at_ms.is_some());
        // Idempotent: a second cancel reports the same terminal state.
        assert_eq!(
            service.cancel(&started.id, &leases).await.unwrap().status,
            "cancelled"
        );
        assert!(service.status("missing").is_none());
        assert_eq!(
            service.cancel("missing", &leases).await.unwrap_err(),
            "pi_work_not_found"
        );
        leases
            .lock()
            .await
            .reserve_work(&root, "another")
            .expect("lease released");
    }

    #[tokio::test]
    #[ignore = "requires node and local Ollama; bounded code-repair acceptance"]
    async fn vendored_sidecar_repairs_code_against_independent_reference() {
        code_repair_acceptance(false, "mean").await;
    }

    #[tokio::test]
    #[ignore = "requires node and local Ollama; code repair with approved test feedback"]
    async fn vendored_sidecar_repairs_with_test_feedback() {
        code_repair_acceptance(true, "mean").await;
    }

    #[tokio::test]
    #[ignore = "requires node and local Ollama; independent line normalization acceptance"]
    async fn vendored_sidecar_repairs_lines_with_required_verification() {
        code_repair_acceptance(true, "lines").await;
    }

    #[tokio::test]
    #[ignore = "requires node and local Ollama; three-file event projector with independent verification"]
    async fn vendored_sidecar_repairs_projector_with_required_verification() {
        code_repair_acceptance(true, "event-projector-v1").await;
    }

    async fn code_repair_acceptance(verify: bool, task: &str) {
        let model = std::env::var("PI_WORK_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
        assert!(
            model.starts_with("ollama/"),
            "this acceptance fixture only authorizes local inference"
        );
        run_code_repair_acceptance(verify, task, model).await;
    }

    #[tokio::test]
    #[ignore = "requires explicit approval and Pi openai-codex login; consumes subscription usage"]
    async fn pi_codex_repairs_mean_with_required_verification() {
        pi_codex_acceptance("mean").await;
    }

    #[tokio::test]
    #[ignore = "requires explicit approval and Pi openai-codex login; consumes subscription usage"]
    async fn pi_codex_repairs_lines_with_required_verification() {
        pi_codex_acceptance("lines").await;
    }

    #[tokio::test]
    #[ignore = "requires separate approval for event-projector-v1; consumes subscription usage"]
    async fn pi_codex_repairs_projector_with_required_verification() {
        pi_codex_acceptance("event-projector-v1").await;
    }

    async fn pi_codex_acceptance(task: &str) {
        let approval = match task {
            "mean" | "lines" => "approved",
            "event-projector-v1" => "event-projector-v1",
            _ => panic!("unknown Pi Codex acceptance task"),
        };
        assert_eq!(
            std::env::var("HUB_PI_CODEX_ACCEPTANCE").as_deref(),
            Ok(approval),
            "Pi Codex acceptance requires its own explicit approval before any provider probe"
        );
        assert!(
            std::env::var_os("PI_WORK_SIDECAR").is_none(),
            "use the reviewed bundled sidecar"
        );
        assert_eq!(
            std::env::var("PI_WORK_ACCEPTANCE_ENGINE")
                .as_deref()
                .unwrap_or("thin"),
            "thin"
        );
        let model = "openai-codex/gpt-5.6-luna";
        let probe = probe_models_registry()
            .await
            .expect("Pi model readiness unavailable");
        assert!(
            probe
                .ready
                .as_ref()
                .is_some_and(|ready| ready.iter().any(|ready| ready == model)),
            "Pi openai-codex login is required; CLI login alone does not authorize this connection"
        );
        run_code_repair_acceptance(true, task, model.into()).await;
    }

    async fn run_code_repair_acceptance(verify: bool, task: &str, model: String) {
        let (_guard, root) = temp_workspace();
        run_code_repair_in_workspace(verify, task, model, root).await;
    }

    #[tokio::test]
    #[ignore = "requires the owned loopback cache benchmark server and sidecar instrumentation"]
    async fn vendored_sidecar_cache_comparison_preserves_verified_code() {
        run_cache_comparison("lines", "exact-v1").await;
    }

    #[tokio::test]
    #[ignore = "requires the owned loopback cache benchmark server and sidecar instrumentation"]
    async fn vendored_sidecar_cache_comparison_preserves_verified_behavior() {
        run_cache_comparison("lines-functional-v1", "lines-functional-v1").await;
    }

    async fn run_cache_comparison(task: &str, profile: &str) {
        assert_eq!(
            std::env::var("HUB_LOCAL_CACHE_BENCHMARK").as_deref(),
            Ok("local-only")
        );
        let base = reqwest::Url::parse(&std::env::var("HUB_LOCAL_CACHE_URL").unwrap()).unwrap();
        assert_eq!(base.scheme(), "http");
        assert_eq!(base.host_str(), Some("127.0.0.1"));
        assert!(base.port().is_some());
        println!("cache comparison profile: {profile}");
        let (_guard, root) = temp_workspace();
        let mut reference = None;
        for (index, (label, cached)) in [
            ("A0", false),
            ("A1", false),
            ("B0", true),
            ("B1", true),
            ("A2", false),
        ]
        .into_iter()
        .enumerate()
        {
            if index > 0 {
                // This fixture owns this exact canonical temporary directory.
                assert_eq!(
                    root.parent().unwrap(),
                    std::env::temp_dir().canonicalize().unwrap()
                );
                assert!(root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("hub-pi-work-"));
                assert_eq!(root.canonicalize().unwrap(), root);
                std::fs::remove_dir_all(&root).unwrap();
                std::fs::create_dir(&root).unwrap();
            }
            std::env::set_var("HUB_LOCAL_CACHE_TRIAL", label);
            std::env::set_var("HUB_LOCAL_CACHE_ENABLED", if cached { "true" } else { "false" });
            let (view, source, behavior) = run_code_repair_in_workspace(
                true,
                task,
                "hub-cache-eval/fixture".into(),
                root.clone(),
            )
            .await;
            println!(
                "cache benchmark: {}",
                json!({"profile":profile,"trial":label,"cached":cached,"elapsedMs":now_ms().saturating_sub(view.started_at_ms),"usage":view.usage,"source":source,"final":view.final_output,"behavior":behavior,"status":view.status,"verification":view.verification.as_ref().map(|check| check.status.as_str())})
            );
            let output = if profile == "exact-v1" {
                json!({"source":source,"final":view.final_output})
            } else {
                assert!(behavior.is_some(), "independent behavior result missing");
                json!(behavior)
            };
            if let Some(expected) = &reference {
                assert_eq!(&output, expected, "{profile} output changed in {label}");
            } else {
                reference = Some(output);
            }
        }
    }

    fn lines_functional_reference() -> String {
        format!(
            "{}\nconsole.log(JSON.stringify(module.exports.verifySource(require('node:fs').readFileSync('src/lines.cjs', 'utf8'))));",
            include_str!("../../scripts/lines-functional-reference.cjs")
        )
    }

    const PROJECTOR_BENCHMARK: &str = include_str!("../../scripts/projector-benchmark.cjs");

    fn projector_reference() -> String {
        format!("{PROJECTOR_BENCHMARK}\nconsole.log(JSON.stringify(module.exports.verifyWorkspace(process.cwd())));")
    }

    async fn projector_definition(root: &Path) -> serde_json::Value {
        let result = code_repair_reference(
            root,
            &format!("{PROJECTOR_BENCHMARK}\nconsole.log(JSON.stringify({{instruction:module.exports.instruction,files:module.exports.files}}));"),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(result.status.success(), "projector definition failed");
        serde_json::from_slice(&result.stdout).unwrap()
    }

    async fn run_code_repair_in_workspace(
        verify: bool,
        task: &str,
        model: String,
        root: PathBuf,
    ) -> (PiRunState, String, Option<serde_json::Value>) {
        std::fs::create_dir(root.join("src")).unwrap();
        let projector = if task == "event-projector-v1" {
            let definition = projector_definition(&root).await;
            for (name, source) in definition["files"].as_object().unwrap() {
                std::fs::write(root.join(name), source.as_str().unwrap()).unwrap();
            }
            std::fs::write(root.join("TASK.md"), definition["instruction"].as_str().unwrap()).unwrap();
            definition
        } else {
            serde_json::Value::Null
        };
        let (path, broken, request, verification) = match task {
            "event-projector-v1" => ("src/index.cjs", projector["files"]["src/index.cjs"].as_str().unwrap(),
                projector["instruction"].as_str().unwrap(), projector["files"]["verify.cjs"].as_str().unwrap()),
            "mean" => ("src/metrics.cjs", "exports.mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length - 1);\n",
                "Find the mean function in this project and fix it. For an empty array it must return null. For nonempty finite numbers it must return the arithmetic mean, including one value and negative values.",
                "const a=require('node:assert/strict');const{mean}=require('./src/metrics.cjs');for(const [input,want] of [[[],null],[[7],7],[[-2,4],1],[[0,0],0],[[1,2,6],3],[[.5,1.5],1]])a.equal(mean(input),want);"),
            "lines" => ("src/lines.cjs", "exports.uniqueLines = text => text.split('\\n');\n",
                "Find uniqueLines and fix it. It must accept text with LF or CRLF lines, trim whitespace around each line, remove empty lines, and return unique lines in their first-occurrence order. Case is significant. Preserve Unicode and the CommonJS export.",
                r#"const a=require('node:assert/strict');const{uniqueLines}=require('./src/lines.cjs');for(const[input,want]of[["",[]],["a",["a"]],["a\na\nb",["a","b"]],[" a \r\nb\r\n a ",["a","b"]],[" \n\t\n",[]],["日\n日\nA\na",["日","A","a"]]])a.deepEqual(uniqueLines(input),want);"#),
            "lines-functional-v1" => ("src/lines.cjs", "exports.uniqueLines = text => text.split('\\n');\n",
                "Find uniqueLines and fix it. Input is any JavaScript string. Split LF, CRLF and standalone CR lines, trim JavaScript whitespace around each line, remove empty lines, and return unique strings in first-occurrence order. Case, internal whitespace and all other characters are significant. Preserve Unicode exactly, without normalization. Keep the CommonJS export and do not retain state between calls.",
                r#"const a=require('node:assert/strict');const{uniqueLines}=require('./src/lines.cjs');for(const[input,want]of[["",[]],["a",["a"]],["a\na\nb",["a","b"]],[" a \r\nb\r\n a ",["a","b"]],[" \n\t\n",[]],["日\n日\nA\na",["日","A","a"]],["a\rb",["a","b"]]])a.deepEqual(uniqueLines(input),want);"#),
            _ => panic!("unknown acceptance task"),
        };
        std::fs::write(root.join(path), broken).unwrap();
        std::fs::write(
            root.join("README.md"),
            if task == "mean" {
                "The metrics module computes the arithmetic mean.\n"
            } else if task == "event-projector-v1" {
                "Read TASK.md for the three-module event projection contract.\n"
            } else {
                "The lines module normalizes unique lines.\n"
            },
        )
        .unwrap();
        if verify {
            std::fs::write(root.join("verify.cjs"), verification).unwrap();
        }
        let prompt = format!(
            "{request} Edit the existing source; add no dependencies. Read before editing. {}",
            if verify {
                "Run the existing test with hub_exec using program node and args [\"verify.cjs\"], omitting cwd. Read any failure and fix the source until the test passes. Do not change verify.cjs."
            } else {
                "Command execution is unavailable; state that tests were not run."
            }
        );
        let engine = std::env::var("PI_WORK_ACCEPTANCE_ENGINE").unwrap_or_else(|_| "thin".into());
        assert!(["thin", "dsh"].contains(&engine.as_str()));
        let store = crate::checkpoint::CheckpointStore::test(root.join(".sessions"), [5; 32]);
        let service = PiWorkService {
            checkpoints: Some(store.clone()),
            ..PiWorkService::default()
        };
        let leases = leases();
        let started = service
            .start_with_resume(
                SidecarSpec {
                    program: "node".into(),
                    args: vec![
                        resolve_script(None).unwrap().to_string_lossy().into_owned(),
                        model.clone(),
                        prompt.clone(),
                    ],
                    workspace: root.clone(),
                    env: vec![
                        (
                            "PI_SIDECAR_CAPS".into(),
                            if verify { "exec" } else { "" }.into(),
                        ),
                        ("PI_SIDECAR_SESSION".into(), "1".into()),
                        ("PI_WORK_ENGINE".into(), engine),
                    ],
                },
                model,
                prompt.into(),
                false,
                verify,
                false,
                false,
                None,
                &leases,
                verify.then(|| {
                    serde_json::from_value(json!({"program":"node","args":["verify.cjs"]})).unwrap()
                }),
            )
            .await
            .unwrap();
        let mut view = started;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(450);
        while tokio::time::Instant::now() < deadline {
            if view.status != "running" {
                break;
            }
            for action in view.pending_actions.clone() {
                let approved = matches!(action.tool.as_str(), "hub_edit" | "hub_write")
                    || (verify
                        && action.tool == "hub_exec"
                        && action.summary == crate::agent_exec::ExecRequest::parse(
                            json!({"program":"node","args":["verify.cjs"]})
                        ).unwrap().describe()
                        && std::fs::read_to_string(root.join("verify.cjs")).unwrap()
                            == verification);
                service
                    .decide(&view.id, &action.id, approved, None)
                    .unwrap();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            view = service.status(&view.id).unwrap();
        }
        if view.status == "running" {
            view = service.cancel(&view.id, &leases).await.unwrap();
        }
        println!(
            "acceptance: {}",
            serde_json::json!({
                "task": task,
                "model": view.model,
                "engine": view.engine,
                "elapsedMs": now_ms().saturating_sub(view.started_at_ms),
                "usage": view.usage,
                "toolCalls": view.tool_calls.len(),
            })
        );
        // The model cannot alter this reference: it is held outside its workspace
        // and runs only after the lease has been released.
        let reference_program = if task == "lines-functional-v1" {
            lines_functional_reference()
        } else if task == "event-projector-v1" {
            projector_reference()
        } else {
            verification.to_owned()
        };
        let result = code_repair_reference(&root, &reference_program, Duration::from_secs(10))
            .await
            .expect("independent reference could not finish");
        let context = store
            .load::<PiCheckpoint>(&view.id)
            .map(|saved| saved.entries);
        let last = context
            .as_ref()
            .and_then(|entries| entries.as_array())
            .and_then(|entries| entries.last());
        if let Some(entries) = context.as_ref().and_then(|entries| entries.as_array()) {
            let errors: Vec<_> = entries
                .iter()
                .filter_map(|entry| {
                    let message = &entry["message"];
                    (message["role"] == "toolResult" && message["isError"] == true).then_some(
                        serde_json::json!({"tool":message["toolName"],"error":message["content"]}),
                    )
                })
                .collect();
            println!("acceptance tool errors: {}", serde_json::json!(errors));
        }
        if task == "event-projector-v1" && (view.status != "done" || !result.status.success()) {
            // Only this synthetic fixture's bounded, regular source files.
            // Keep failed generated code inspectable before the temp guard cleans up.
            if std::fs::symlink_metadata(root.join("src")).is_ok_and(|m| m.file_type().is_dir()) {
                for name in ["parse", "project", "index"] {
                    let path = root.join(format!("src/{name}.cjs"));
                    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= 16384) {
                        println!("acceptance source {name}: {}", std::fs::read_to_string(path).unwrap());
                    }
                }
            }
        }
        assert!(
            view.status == "done" && result.status.success(),
            "execution status: {}\nreference: {}\nsidecar: {}\ncalls: {:?}\nlast: {:?}",
            view.status,
            String::from_utf8_lossy(&result.stderr),
            view.stderr_tail,
            view.tool_calls,
            last
        );
        if verify {
            assert_eq!(
                view.verification
                    .as_ref()
                    .map(|check| check.status.as_str()),
                Some("passed")
            );
            assert!(
                view.tool_calls
                    .iter()
                    .any(|call| call.name == "hub_exec" && call.ok == Some(true)),
                "required verification was not executed"
            );
        }
        let source = std::fs::read_to_string(root.join(path)).unwrap();
        let behavior = matches!(task, "lines-functional-v1" | "event-projector-v1")
            .then(|| serde_json::from_slice(&result.stdout).expect("missing behavior result"));
        (view, source, behavior)
    }

    #[tokio::test]
    async fn projector_reference_is_embedded_and_rejects_editable_check_tampering() {
        let (_guard, root) = temp_workspace();
        let definition = projector_definition(&root).await;
        std::fs::create_dir(root.join("src")).unwrap();
        for (name, source) in definition["files"].as_object().unwrap() {
            std::fs::write(root.join(name), source.as_str().unwrap()).unwrap();
        }
        std::fs::write(root.join("TASK.md"), definition["instruction"].as_str().unwrap()).unwrap();
        let code = projector_reference();
        let broken = code_repair_reference(&root, &code, Duration::from_secs(10)).await.unwrap();
        assert!(!broken.status.success());
        std::fs::write(root.join("verify.cjs"), "process.exit(0)").unwrap();
        let tampered = code_repair_reference(&root, &code, Duration::from_secs(10)).await.unwrap();
        assert!(!tampered.status.success());
        assert!(String::from_utf8_lossy(&tampered.stderr).contains("visible check changed"));
    }

    async fn code_repair_reference(
        root: &Path,
        verification: &str,
        limit: Duration,
    ) -> Result<std::process::Output, &'static str> {
        tokio::time::timeout(
            limit,
            crate::local_cli::quiet_command("node")
                .args(["-e", verification])
                .current_dir(root)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "independent_reference_timeout")?
        .map_err(|_| "independent_reference_spawn_failed")
    }

    #[tokio::test]
    async fn code_repair_reference_preserves_failure_and_bounds_execution() {
        let (_guard, root) = temp_workspace();
        for (code, succeeds) in [
            ("require('node:assert/strict').equal(1, 1)", true),
            ("require('node:assert/strict').equal(1, 2)", false),
        ] {
            let result = code_repair_reference(&root, code, Duration::from_secs(10))
                .await
                .unwrap();
            assert_eq!(result.status.success(), succeeds);
        }
        assert_eq!(
            code_repair_reference(&root, "while (true) {}", Duration::from_millis(500))
                .await
                .unwrap_err(),
            "independent_reference_timeout"
        );
    }

    #[tokio::test]
    async fn code_repair_functional_reference_checks_saved_source() {
        let (_guard, root) = temp_workspace();
        std::fs::create_dir(root.join("src")).unwrap();
        for (source, succeeds) in [
            (r#"exports.uniqueLines = t => [...new Set(t.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean))];"#, true),
            (r#"exports.uniqueLines = t => [...new Set(t.split(/\r\n|\n/).map(s => s.trim()).filter(Boolean))];"#, false),
        ] {
            std::fs::write(root.join("src/lines.cjs"), source).unwrap();
            let result = code_repair_reference(
                &root,
                &lines_functional_reference(),
                Duration::from_secs(10),
            )
            .await
            .unwrap();
            assert_eq!(result.status.success(), succeeds);
            if succeeds {
                let result: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
                assert_eq!(result["profile"], "lines-functional-v1");
                assert_eq!(result["cases"], 362);
            }
        }
    }

    /// A sidecar that exits before agent_done reports a failure, with the
    /// early stderr tail captured for diagnosis.
    #[tokio::test]
    #[ignore = "requires node on PATH"]
    async fn early_exit_fails_with_stderr_tail() {
        let script = "console.error('boom'); process.exit(3);";
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let leases = leases();
        let started = service
            .start(
                SidecarSpec {
                    program: PathBuf::from("node"),
                    args: vec!["-e".into(), script.into()],
                    workspace: root,
                    env: Vec::new(),
                },
                "m".into(),
                "p".into(),
                false,
                false,
                false,
                false,
                &leases,
            )
            .await
            .expect("start");
        let view = terminal(&service, &started.id).await;
        assert_eq!(view.status, "failed");
        let outcome = view.outcome.as_ref().expect("outcome");
        assert!(!outcome.ok);
        assert!(outcome
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("agent_done"));
        assert!(view.stderr_tail.contains("boom"), "{}", view.stderr_tail);
        assert!(view.hello.is_none());
    }

    #[test]
    fn run_state_json_shape_matches_the_window_contract() {
        // The window reads exact keys; pin the whole contract of one run.
        let state = PiRunState {
            image_attachments: Vec::new(), image_context_refs: Vec::new(), prompt_image_ids: Vec::new(), reattached_image_ids: Vec::new(), image_request_id: None, image_receipt_valid: true,
            fast_check: None, best_of: None,
            generation: None, supports_steering: false, instructions: Vec::new(), changes: PiChangeSummary::default(),
            verification: None,
            engine: WorkEngine::Thin,
            usage: PiUsage::default(),
            final_output: String::new(),
            continuation: PiContinuation::default(),
            id: "r".into(),
            workspace: "w".into(),
            script: "s".into(),
            model: "m".into(),
            prompt: "p".into(),
            allow_write: false,
            allow_exec: false,
            allow_http: false,
            allow_test: false,
            status: "done".into(),
            hello: None,
            tool_calls: vec![],
            pending_actions: vec![],
            agent_events: 0,
            partial_output: String::new(),
            outcome: Some(PiOutcome { verified: false,
                ok: true,
                exit_code: Some(0),
                error: None,
            }),
            stderr_tail: String::new(),
            started_at_ms: 1,
            ended_at_ms: Some(2),
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(
            value,
            json!({
                "id": "r",
                "changes": serde_json::to_value(PiChangeSummary::default()).unwrap(),
                "verification": null,
                "engine": "thin",
                "usage": {"requests": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "continuation": {"available": false, "resumedFrom": null, "error": null},
                "finalOutput": "", "supportsSteering": false, "instructions": [],
                "workspace": "w",
                "script": "s",
                "model": "m",
                "prompt": "p",
                "allowWrite": false,
                "allowExec": false,
                "allowHttp": false,
                "allowTest": false,
                "status": "done",
                "hello": null,
                "toolCalls": [],
                "pendingActions": [],
                "agentEvents": 0,
                "partialOutput": "",
                "outcome": {"ok": true, "exitCode": 0},
                "stderrTail": "",
                "startedAtMs": 1,
                "endedAtMs": 2
            })
        );
    }

    /// The stub sidecar proposes one `hub_write`; the answer decides its
    /// `agent_done`. Parking shows up as a `pendingActions` entry the real
    /// `decide` path resolves — the same round trip the window drives.
    const WRITE_ASKING_SIDECAR: &str = r#"
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'hello', proto: 1, activeTools: ['hub_write'], tools: [{ name: 'hub_write', description: 'd', parameters: { type: 'object' } }] });
setTimeout(() => send({ type: 'tool_call', id: 'tc_1', name: 'hub_write', args: { path: 'made.txt', content: 'approved content', summary: 'test write' } }), 30);
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'tool_result') { send({ type: 'agent_done', ok: true }); process.exit(0); }
  if (msg.type === 'tool_error') { send({ type: 'agent_done', ok: false }); process.exit(0); }
});
"#;

    /// Approving a parked write applies it through the ordinary path.
    /// Requires `node` on PATH; run with `cargo test pi_work -- --ignored`.
    #[tokio::test]
    #[ignore = "requires node on PATH"]
    async fn approve_parks_then_applies_the_write() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let leases = leases();
        let started = service
            .start(
                SidecarSpec {
                    program: PathBuf::from("node"),
                    args: vec!["-e".into(), WRITE_ASKING_SIDECAR.into()],
                    workspace: root.clone(),
                    env: Vec::new(),
                },
                "m".into(),
                "p".into(),
                false,
                false,
                false,
                false,
                &leases,
            )
            .await
            .expect("start");
        let pending = pending_action(&service, &started.id).await;
        assert_eq!(pending.tool, "hub_write");
        assert!(pending.summary.contains("made.txt"), "{}", pending.summary);
        let view = service
            .decide(&started.id, &pending.id, true, None)
            .expect("approve");
        assert!(view.pending_actions.is_empty());
        let view = terminal(&service, &started.id).await;
        assert_eq!(view.status, "done", "stderr: {}", view.stderr_tail);
        assert_eq!(view.tool_calls[0].ok, Some(true));
        assert_eq!(
            std::fs::read_to_string(root.join("made.txt")).unwrap(),
            "approved content"
        );
        // The decision was single-use even though the run is now terminal.
        assert_eq!(
            service
                .decide(&started.id, &pending.id, false, None)
                .unwrap_err(),
            "pi_action_not_found"
        );
    }

    /// Denying a parked write answers the tool call with `approval_denied`;
    /// the sidecar's `agent_done ok:false` ends the run and nothing is written.
    #[tokio::test]
    #[ignore = "requires node on PATH"]
    async fn deny_parks_then_refuses_the_write() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let leases = leases();
        let started = service
            .start(
                SidecarSpec {
                    program: PathBuf::from("node"),
                    args: vec!["-e".into(), WRITE_ASKING_SIDECAR.into()],
                    workspace: root.clone(),
                    env: Vec::new(),
                },
                "m".into(),
                "p".into(),
                false,
                false,
                false,
                false,
                &leases,
            )
            .await
            .expect("start");
        let pending = pending_action(&service, &started.id).await;
        service
            .decide(&started.id, &pending.id, false, None)
            .expect("deny");
        let view = terminal(&service, &started.id).await;
        assert_eq!(view.status, "failed");
        assert_eq!(view.tool_calls[0].ok, Some(false));
        assert!(!root.join("made.txt").exists());
    }

    /// One history file across two service instances: the real `cancel`
    /// transition writes the terminal line, and a second service restores
    /// it as a dead run that cancel and decide cannot touch.
    #[tokio::test]
    async fn terminal_runs_persist_and_restore_as_dead_runs() {
        let (_guard, root) = temp_workspace();
        let history = root.join("pi-work-runs.jsonl");
        let service = PiWorkService::with_history(history.clone());
        let leases = leases();
        insert_run(
            &service,
            "r1",
            &root,
            Arc::new(Mutex::new(running_state("r1", &root))),
            Arc::new(Mutex::new(HashMap::new())),
        );
        let cancelled = service.cancel("r1", &leases).await.expect("cancel");
        assert_eq!(cancelled.status, "cancelled");

        let lines: Vec<String> = std::fs::read_to_string(&history)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(lines.len(), 1);
        let stored: PiRunState = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(stored.id, "r1");
        assert_eq!(stored.status, "cancelled");
        assert!(stored.ended_at_ms.is_some());

        let restored = PiWorkService::with_history(history.clone());
        let view = restored.status("r1").expect("restored run");
        assert_eq!(view.status, "cancelled");
        assert_eq!(view.workspace, root.to_string_lossy());
        assert_eq!(view.model, "m");
        assert!(restored.list().iter().any(|state| state.id == "r1"));

        // Restored runs are data, never authority: cancel reports the
        // stored state unchanged, no decision channel exists, and nothing
        // is written back into the file they came from.
        let again = restored
            .cancel("r1", &leases)
            .await
            .expect("cancel restored");
        assert_eq!(again.status, "cancelled");
        assert_eq!(
            restored.decide("r1", "any", true, None).unwrap_err(),
            "pi_action_not_found"
        );
        assert_eq!(
            std::fs::read_to_string(&history).unwrap().lines().count(),
            1,
            "restored runs must not re-record"
        );
    }

    /// `Default` carries no history path, so the whole pipeline short-
    /// circuits before touching the disk.
    #[tokio::test]
    async fn default_service_writes_no_history() {
        let (_guard, root) = temp_workspace();
        let service = PiWorkService::default();
        let leases = leases();
        insert_run(
            &service,
            "r1",
            &root,
            Arc::new(Mutex::new(running_state("r1", &root))),
            Arc::new(Mutex::new(HashMap::new())),
        );
        service.cancel("r1", &leases).await.expect("cancel");
        service.record_terminal(&AtomicBool::new(false), &running_state("r2", &root));
        assert!(root.read_dir().unwrap().next().is_none());
    }

    /// A stored line is just a serialized `PiRunState`; it parses back with
    /// every field intact.
    #[test]
    fn history_lines_round_trip_through_serde() {
        let (_guard, root) = temp_workspace();
        let mut state = running_state("r1", &root);
        state.status = "done".into();
        state.ended_at_ms = Some(9);
        let line = serde_json::to_string(&state).unwrap();
        let parsed: PiRunState = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed.id, "r1");
        assert_eq!(parsed.status, "done");
        assert_eq!(parsed.model, "m");
        assert_eq!(parsed.started_at_ms, state.started_at_ms);
        assert_eq!(parsed.ended_at_ms, Some(9));
    }

    /// Malformed and non-terminal lines are skipped; a repeated id keeps
    /// the last line without duplicating the order list.
    #[test]
    fn restore_skips_malformed_lines_and_dedups_ids() {
        let (_guard, root) = temp_workspace();
        let history = root.join("pi-work-runs.jsonl");
        let mut done = running_state("r1", &root);
        done.status = "done".into();
        let mut failed = running_state("r1", &root);
        failed.status = "failed".into();
        let zombie = running_state("r2", &root);
        let body = format!(
            "{}\nnot-json\n{}\n{}\n",
            serde_json::to_string(&done).unwrap(),
            serde_json::to_string(&failed).unwrap(),
            serde_json::to_string(&zombie).unwrap(),
        );
        std::fs::write(&history, body).unwrap();
        let service = PiWorkService::with_history(history);
        let list = service.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "r1");
        assert_eq!(list[0].status, "failed");
    }

    /// Past the cap the file is rewritten to the newest tail plus the
    /// incoming line.
    #[test]
    fn history_metadata_never_writes_prompt_response_target_or_diagnostics() {
        let (_guard, root) = temp_workspace();
        let history = root.join("pi-work-runs.jsonl");
        let mut state = running_state("private-test", &root);
        state.status = "failed".into();
        state.prompt = "synthetic-private-prompt".into();
        state.final_output = "synthetic-private-final".into();
        state.partial_output = "synthetic-private-partial".into();
        state.stderr_tail = "synthetic-private-diagnostic".into();
        state.tool_calls.push(PiToolCall { id: "call".into(), name: "hub_write".into(),
            detail: Some("synthetic-private-target".into()), preview: Some("synthetic-private-preview".into()), ok: Some(false) });
        state.outcome = Some(PiOutcome { verified: false, ok: false, exit_code: Some(1), error: Some("synthetic-private-error".into()) });
        append_history(&history, &state).unwrap();
        let plain = std::fs::read_to_string(&history).unwrap();
        assert!(!plain.contains("synthetic-private-"));
        let metadata: PiRunState = serde_json::from_str(plain.trim()).unwrap();
        assert_eq!(metadata.id, state.id);
        assert_eq!(metadata.status, "failed");
        assert_eq!(metadata.tool_calls[0].name, "hub_write");
        assert_eq!(metadata.outcome.unwrap().error.as_deref(), Some("pi_work_failed"));
        assert_eq!(state.prompt, "synthetic-private-prompt");
        assert_eq!(state.final_output, "synthetic-private-final");
    }

    #[test]
    fn history_rewrite_keeps_the_newest_entries() {
        let (_guard, root) = temp_workspace();
        let history = root.join("pi-work-runs.jsonl");
        let mut body = String::new();
        for index in 0..HISTORY_CAP_LINES {
            let mut state = running_state(&format!("r{index}"), &root);
            state.status = "done".into();
            body.push_str(&serde_json::to_string(&state).unwrap());
            body.push('\n');
        }
        std::fs::write(&history, body).unwrap();
        let mut state = running_state("new", &root);
        state.status = "done".into();
        append_history(&history, &state).unwrap();
        let kept: Vec<String> = std::fs::read_to_string(&history)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(kept.len(), HISTORY_KEEP_LINES);
        let first: PiRunState = serde_json::from_str(&kept[0]).unwrap();
        assert_eq!(
            first.id,
            format!("r{}", HISTORY_CAP_LINES + 1 - HISTORY_KEEP_LINES)
        );
        let last: PiRunState = serde_json::from_str(kept.last().unwrap()).unwrap();
        assert_eq!(last.id, "new");
    }

    /// The picker lists "provider/id" out of the machine's pi registry;
    /// malformed entries drop out instead of failing the whole list.
    #[test]
    fn flatten_models_lists_provider_id_specs() {
        let registry = json!({
            "providers": {
                "ollama": { "models": [{"id": "qwen2.5:3b"}, {"id": "qwen2.5:1.5b"}] },
                "openai": { "models": [{"id": "gpt-5"}, {"name": "no-id"}, "junk"] },
                "empty": { "models": [] },
                "bare": {}
            }
        });
        assert_eq!(
            flatten_models(&registry),
            vec![
                "ollama/qwen2.5:1.5b".to_string(),
                "ollama/qwen2.5:3b".to_string(),
                "openai/gpt-5".to_string(),
            ]
        );
        assert!(flatten_models(&json!({})).is_empty());
        assert!(flatten_models(&json!({"providers": ["nope"]})).is_empty());
    }

    /// The endpoint's payload: the registry's offer plus the default a bare
    /// start would run — and a missing or unparseable registry still answers
    /// with an empty list, since the picker degrades rather than errors.
    #[tokio::test]
    async fn models_reads_the_registry_and_reports_the_default() {
        // PI_CODING_AGENT_DIR / PI_WORK_MODEL are process-global; serialise
        // against the other env-redirecting tests on the shared lock.
        let _env = crate::local_cli::ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_agent_dir = std::env::var_os("PI_CODING_AGENT_DIR");
        let previous_model = std::env::var_os("PI_WORK_MODEL");
        let previous_sidecar = std::env::var_os("PI_WORK_SIDECAR");
        let (_guard, root) = temp_workspace();
        // Point the script override at nothing so the registry probe fails
        // fast — otherwise the test depends on whether this machine happens
        // to have node and a vendored sidecar.
        std::env::set_var("PI_WORK_SIDECAR", root.join("missing.mjs"));
        let agent_dir = root.join("pi-agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            serde_json::to_string(&json!({
                "providers": {
                    "ollama": { "models": [{"id": "qwen2.5:3b"}, {"id": "qwen2.5:1.5b"}] },
                    "openai": { "models": [{"id": "gpt-5"}] }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        std::env::set_var("PI_CODING_AGENT_DIR", &agent_dir);
        std::env::set_var("PI_WORK_MODEL", "ollama/qwen2.5:1.5b");
        let body = PiWorkService::default().models().await;
        assert_eq!(
            body["models"],
            json!(["ollama/qwen2.5:1.5b", "ollama/qwen2.5:3b", "openai/gpt-5"])
        );
        assert_eq!(body["default"], "ollama/qwen2.5:1.5b");

        // An unreadable registry degrades to an empty list, same 200 shape.
        std::env::set_var("PI_CODING_AGENT_DIR", root.join("absent"));
        let body = PiWorkService::default().models().await;
        assert_eq!(body["models"], json!([]));
        assert_eq!(body["default"], "ollama/qwen2.5:1.5b");
        // With the probe disabled the auth state is unknown — `ready` stays
        // absent rather than reporting a false empty list.
        assert!(body.get("ready").is_none());

        // Restore the environment for the next test holding the lock.
        match previous_agent_dir {
            Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
            None => std::env::remove_var("PI_CODING_AGENT_DIR"),
        }
        match previous_model {
            Some(value) => std::env::set_var("PI_WORK_MODEL", value),
            None => std::env::remove_var("PI_WORK_MODEL"),
        }
        match previous_sidecar {
            Some(value) => std::env::set_var("PI_WORK_SIDECAR", value),
            None => std::env::remove_var("PI_WORK_SIDECAR"),
        }
    }

    /// The full probe is a live sidecar run — gated like the other
    /// node/model E2E tests. When it runs, the registry must include the
    /// builtin providers, not only models.json entries.
    #[tokio::test]
    #[ignore = "requires node and the vendored sidecar"]
    async fn models_probe_lists_the_full_pi_registry() {
        let probe = probe_models_registry()
            .await
            .expect("probe should succeed with node + vendored sidecar");
        assert!(
            probe.models.iter().any(|m| m.starts_with("anthropic/")),
            "builtin providers missing: {} entries",
            probe.models.len()
        );
        // The ready list is the runnable subset — on a machine with local
        // ollama only, it is the ollama entries.
        if let Some(ready) = &probe.ready {
            assert!(ready.iter().all(|m| probe.models.contains(m)));
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiSteerReceipt {
    pub run_id: String,
    pub request_id: String,
    pub delivery_id: String,
    pub user_message_id: String,
    pub accepted: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PiInstructionState {
    Accepted,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiSteerInstruction {
    pub request_id: String,
    pub delivery_id: String,
    pub user_message_id: String,
    pub text: String,
    pub accepted_at_ms: u128,
    pub state: PiInstructionState,
}
#[derive(Clone)]
enum SteerReservedState {
    Unknown,
    Accepted,
    Rejected(&'static str),
}
struct SteerReserved {
    text: String,
    receipt: PiSteerReceipt,
    state: SteerReservedState,
}
#[derive(Default)]
struct SteeringLedger {
    requests: HashMap<String, SteerReserved>,
    utf16: usize,
}
fn steer_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        value.len() == 36
            && id.to_string() == value
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
    })
}
fn steer_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0') && value.encode_utf16().count() <= 8000
}
fn steer_eligible(state: &PiRunState, workspace: &Path, selected: Option<&PathBuf>) -> bool {
    state.status == "running"
        && state.engine == WorkEngine::Thin
        && state
            .hello
            .as_ref()
            .is_some_and(|hello| hello.supports_steering)
        && selected.is_some_and(|selected| selected == workspace)
}
impl SteeringLedger {
    fn existing(&self, request: &str, text: &str) -> Result<Option<PiSteerReceipt>, String> {
        let Some(entry) = self.requests.get(request) else {
            return Ok(None);
        };
        if entry.text != text {
            return Err("pi_work_steer_id_conflict".to_owned());
        }
        match entry.state {
            SteerReservedState::Accepted => Ok(Some(entry.receipt.clone())),
            SteerReservedState::Rejected(code) => Err(format!("pi_work_{code}")),
            SteerReservedState::Unknown => Err("pi_work_steer_unknown".to_owned()),
        }
    }
    fn reserve(&mut self, run: &str, request: &str, text: &str) -> Result<(), String> {
        let count = text.encode_utf16().count();
        let total = self.utf16.checked_add(count).ok_or("pi_work_steer_limit")?;
        if self.requests.len() >= 16 || total > 32768 || self.requests.contains_key(request) {
            return Err("pi_work_steer_limit".to_owned());
        }
        self.requests.insert(
            request.to_owned(),
            SteerReserved {
                text: text.to_owned(),
                receipt: PiSteerReceipt {
                    run_id: run.to_owned(),
                    request_id: request.to_owned(),
                    delivery_id: uuid::Uuid::new_v4().to_string(),
                    user_message_id: uuid::Uuid::new_v4().to_string(),
                    accepted: true,
                },
                state: SteerReservedState::Unknown,
            },
        );
        self.utf16 = total;
        Ok(())
    }
}
fn apply_known_ack(
    ledger: &mut SteeringLedger,
    state: &mut PiRunState,
    request: &str,
    ack: &crate::pi_sidecar::SteerAckRecord,
) -> bool {
    let Some(entry) = ledger.requests.get_mut(request) else {
        return false;
    };
    if !matches!(entry.state, SteerReservedState::Unknown) {
        return false;
    }
    match &ack.result {
        Ok(()) => {
            entry.state = SteerReservedState::Accepted;
            state.instructions.push(PiSteerInstruction {
                request_id: request.to_owned(),
                delivery_id: entry.receipt.delivery_id.clone(),
                user_message_id: entry.receipt.user_message_id.clone(),
                text: entry.text.clone(),
                accepted_at_ms: ack.received_at_ms,
                state: PiInstructionState::Accepted,
            });
            true
        }
        Err(SteerFailure::Rejected(code)) => {
            entry.state = SteerReservedState::Rejected(code);
            false
        }
        _ => false,
    }
}
fn checkpoint_steering(run: &PiRun, state: &mut PiRunState) {
    let Some(store) = &run.steering_checkpoint else {
        return;
    };
    let saved = (|| -> Result<(), String> {
        let mut checkpoint = store
            .load_optional_bounded::<PiCheckpoint>(&state.id, 16 * 1024 * 1024)?
            .unwrap_or(PiCheckpoint {
                workspace: run.workspace.clone(),
                entries: serde_json::Value::Null,
                run: None,
                file_changes: None, read_observations: None,
            });
        if checkpoint.workspace != run.workspace {
            return Err("pi_session_workspace_mismatch".to_owned());
        }
        let mut metadata = state.clone();
        metadata.supports_steering = false;
        clear_transient(&mut metadata);
        checkpoint.run = Some(metadata);
        checkpoint.file_changes = Some(run.file_changes.lock().unwrap().clone());
        store.save(&state.id, &checkpoint)
    })();
    if saved.is_err() {
        state.continuation.error = Some("pi_steer_checkpoint_unavailable".to_owned());
    }
}
fn reconcile_steering(run: &PiRun) {
    let Some(steering) = &run.steering else {
        return;
    };
    let mut ledger = run.steering_ledger.lock().unwrap();
    let requests: Vec<_> = ledger
        .requests
        .iter()
        .filter(|(_, entry)| matches!(entry.state, SteerReservedState::Unknown))
        .map(|(id, _)| id.clone())
        .collect();
    let known: Vec<_> = requests
        .into_iter()
        .filter_map(|id| steering.known_ack(&id).map(|ack| (id, ack)))
        .collect();
    if known.is_empty() {
        return;
    }
    let mut state = run.state.lock().unwrap();
    let mut changed = false;
    for (id, ack) in known {
        changed |= apply_known_ack(&mut ledger, &mut state, &id, &ack);
    }
    if changed {
        checkpoint_steering(run, &mut state);
        run.changes.send_modify(|version| *version += 1);
    }
}
fn valid_restored_instructions(instructions: &[PiSteerInstruction]) -> bool {
    let mut ids = std::collections::HashSet::new();
    instructions.len() <= 16
        && instructions.iter().all(|entry| {
            steer_uuid(&entry.request_id)
                && steer_uuid(&entry.delivery_id)
                && steer_uuid(&entry.user_message_id)
                && steer_text(&entry.text)
                && entry.accepted_at_ms <= 9_007_199_254_740_991
                && ids.insert(&entry.request_id)
        })
        && instructions
            .iter()
            .map(|entry| entry.text.encode_utf16().count())
            .sum::<usize>()
            <= 32768
}
impl PiWorkService {
    async fn steer_selected(
        &self,
        run_id: &str,
        request_id: &str,
        text: &str,
        selected: impl Fn() -> Option<PathBuf>,
        timeout: Duration,
    ) -> Result<PiSteerReceipt, String> {
        if !steer_uuid(request_id) || !steer_text(text) {
            return Err("pi_work_steer_invalid_request".to_owned());
        }
        let run = self.run(run_id).ok_or("pi_work_steer_unavailable")?;
        let _gate = run.steering_gate.lock().await;
        reconcile_steering(&run);
        if let Some(receipt) = run
            .steering_ledger
            .lock()
            .unwrap()
            .existing(request_id, text)?
        {
            return Ok(receipt);
        }
        let steering = run
            .steering
            .as_ref()
            .filter(|steering| steering.ready())
            .ok_or("pi_work_steer_unsupported")?;
        let state = run.state.lock().unwrap().clone();
        let workspace = selected();
        if state.engine != WorkEngine::Thin {
            return Err("pi_work_steer_unsupported".to_owned());
        }
        if !steer_eligible(&state, &run.workspace, workspace.as_ref()) {
            return Err("pi_work_steer_context_changed".to_owned());
        }
        run.steering_ledger
            .lock()
            .unwrap()
            .reserve(run_id, request_id, text)?;
        // A reservation survives timeout/cancel/future drop. It is never automatically sent again.
        let outcome = steering.send(request_id, text, timeout).await;
        if outcome == Err(SteerFailure::Unsupported) {
            if let Some(entry) = run
                .steering_ledger
                .lock()
                .unwrap()
                .requests
                .get_mut(request_id)
            {
                entry.state = SteerReservedState::Rejected("steer_unsupported");
            }
        }
        reconcile_steering(&run);
        if let Some(receipt) = run
            .steering_ledger
            .lock()
            .unwrap()
            .existing(request_id, text)?
        {
            return Ok(receipt);
        }
        Err("pi_work_steer_unknown".to_owned())
    }
}
#[tauri::command]
pub async fn pi_work_steer(
    window: tauri::Webview,
    service: tauri::State<'_, PiWorkService>,
    run_id: String,
    request_id: String,
    text: String,
) -> Result<PiSteerReceipt, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    if !steer_uuid(&run_id) { return Err("pi_work_steer_invalid_request".to_owned()); }
    service
        .steer_selected(
            &run_id,
            &request_id,
            &text,
            crate::dev_cli::workspace,
            Duration::from_secs(10),
        )
        .await
}

#[cfg(test)]
mod steering_work_tests {
    use super::*;
    use serde_json::json;
    const REQUEST: &str = "00000000-0000-4000-8000-000000000001";
    fn state() -> PiRunState {
        serde_json::from_value(json!({"id":"run","workspace":"C:/synthetic","script":"fixed","model":"fixed","prompt":"original","engine":"thin","allowWrite":false,
        "status":"running","hello":{"proto":1,"supportsSteering":true,"activeTools":[],"tools":[]},"toolCalls":[],"pendingActions":[{"id":"approval","tool":"hub_write","summary":"preview","proposedAtMs":1}],
        "agentEvents":0,"outcome":null,"stderrTail":"","startedAtMs":1,"endedAtMs":null})).unwrap()
    }
    fn run(service: &PiWorkService, sender: SidecarSteering) -> Arc<PiRun> {
        let (tx, _rx) = oneshot::channel();
        let run = Arc::new(PiRun {
            steering: Some(sender),
            steering_checkpoint: None,
            steering_ledger: Mutex::new(SteeringLedger::default()),
            steering_gate: tokio::sync::Mutex::new(()),
            file_changes: Arc::new(Mutex::new(PiChangeArchive::default())),
            state: Arc::new(Mutex::new(state())),
            workspace: PathBuf::from("C:/synthetic"),
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            decisions: Arc::new(Mutex::new(HashMap::from([("approval".to_owned(), tx)]))),
            wait: Mutex::new(None),
            recorded: Arc::new(AtomicBool::new(false)),
            changes: watch::channel(0).0,
        });
        service
            .inner
            .lock()
            .unwrap()
            .runs
            .insert("run".into(), Arc::clone(&run));
        run
    }
    #[test]
    fn raw_text_uuid_and_reservation_budgets_are_exact_and_never_reused() {
        assert!(steer_uuid(REQUEST));
        assert!(!steer_uuid(
            &REQUEST.to_uppercase().replace("00000001", "AAAAAAAA")
        ));
        assert!(!steer_uuid("00000000-0000-1000-8000-000000000001"));
        assert!(steer_text(&"😀".repeat(4000)));
        for text in ["😀".repeat(4001), " \n\t".into(), "x\0y".into()] {
            assert!(!steer_text(&text));
        }
        let mut ledger = SteeringLedger::default();
        for i in 0..16 {
            ledger
                .reserve("run", &uuid::Uuid::new_v4().to_string(), "x")
                .unwrap();
            assert_eq!(ledger.requests.len(), i + 1);
        }
        assert!(ledger.reserve("run", REQUEST, "x").is_err());
        let mut ledger = SteeringLedger::default();
        for _ in 0..4 {
            ledger
                .reserve("run", &uuid::Uuid::new_v4().to_string(), &"x".repeat(8000))
                .unwrap();
        }
        ledger.reserve("run", REQUEST, &"x".repeat(768)).unwrap();
        assert_eq!(ledger.utf16, 32768);
        assert!(ledger
            .reserve("run", &uuid::Uuid::new_v4().to_string(), "x")
            .is_err());
    }
    #[tokio::test]
    async fn only_ack_accepts_and_same_id_text_reuses_receipt_without_changing_permissions_approval_or_lease(
    ) {
        let service = PiWorkService::default();
        let (sender, mut frames, _writer) = SidecarSteering::test_sender(true);
        let run = run(&service, sender.clone());
        let mut leases = DevRuns::default();
        leases.reserve_work(&run.workspace, "run").unwrap();
        let sending = service.clone();
        let task = tokio::spawn(async move {
            sending
                .steer_selected(
                    "run",
                    REQUEST,
                    " literal \ntext ",
                    || Some(PathBuf::from("C:/synthetic")),
                    Duration::from_secs(1),
                )
                .await
        });
        let wire: serde_json::Value = serde_json::from_str(&frames.recv().await.unwrap()).unwrap();
        assert_eq!(wire["text"], " literal \ntext ");
        assert!(run.state.lock().unwrap().instructions.is_empty());
        sender.test_ack(REQUEST, true, None);
        let receipt = task.await.unwrap().unwrap();
        assert!(steer_uuid(&receipt.delivery_id));
        assert!(steer_uuid(&receipt.user_message_id));
        let repeat = service
            .steer_selected(
                "run",
                REQUEST,
                " literal \ntext ",
                || Some(PathBuf::from("C:/synthetic")),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(receipt, repeat);
        assert!(service
            .steer_selected(
                "run",
                REQUEST,
                "changed",
                || Some(PathBuf::from("C:/synthetic")),
                Duration::from_secs(1)
            )
            .await
            .is_err());
        assert!(frames.try_recv().is_err());
        let state = run.state.lock().unwrap();
        assert_eq!(state.prompt, "original");
        assert_eq!(state.script, "fixed");
        assert_eq!(state.model, "fixed");
        assert_eq!(state.started_at_ms, 1);
        assert_eq!(state.pending_actions[0].id, "approval");
        assert!(!state.allow_write && !state.allow_exec && !state.allow_http);
        assert_eq!(state.instructions[0].text, " literal \ntext ");
        drop(state);
        assert!(run.decisions.lock().unwrap().contains_key("approval"));
        assert!(leases.reserve_work(&run.workspace, "other").is_err());
    }
    #[tokio::test]
    async fn timeout_retains_ids_late_ack_resolves_by_snapshot_seam_and_never_resends() {
        let service = PiWorkService::default();
        let (sender, mut frames, _writer) = SidecarSteering::test_sender(true);
        let run = run(&service, sender.clone());
        let sending = service.clone();
        let task = tokio::spawn(async move {
            sending
                .steer_selected(
                    "run",
                    REQUEST,
                    "text",
                    || Some(PathBuf::from("C:/synthetic")),
                    Duration::from_millis(20),
                )
                .await
        });
        frames.recv().await.unwrap();
        assert!(task.await.unwrap().is_err());
        let reserved = run.steering_ledger.lock().unwrap().requests[REQUEST]
            .receipt
            .clone();
        assert!(service
            .steer_selected(
                "run",
                REQUEST,
                "text",
                || Some(PathBuf::from("C:/synthetic")),
                Duration::from_millis(20)
            )
            .await
            .is_err());
        assert!(frames.try_recv().is_err());
        sender.test_ack(REQUEST, true, None);
        run.state.lock().unwrap().status = "done".into();
        reconcile_steering(&run);
        assert_eq!(
            run.state.lock().unwrap().instructions[0].user_message_id,
            reserved.user_message_id
        );
        let receipt = service
            .steer_selected("run", REQUEST, "text", || None, Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(receipt, reserved);
        assert!(frames.try_recv().is_err());
    }
    #[tokio::test]
    async fn pre_send_unsupported_is_known_rejection_and_reserved_id_never_retries() {
        let service = PiWorkService::default();
        let (sender, mut frames, _writer) = SidecarSteering::test_sender(true);
        let run = run(&service, sender.clone());
        let result = service
            .steer_selected(
                "run",
                REQUEST,
                "text",
                || {
                    sender.test_capability(false);
                    Some(PathBuf::from("C:/synthetic"))
                },
                Duration::from_millis(20),
            )
            .await;
        assert_eq!(result.unwrap_err(), "pi_work_steer_unsupported");
        assert!(frames.try_recv().is_err());
        assert!(run.state.lock().unwrap().instructions.is_empty());
        sender.test_capability(true);
        assert_eq!(
            service
                .steer_selected(
                    "run",
                    REQUEST,
                    "text",
                    || Some(PathBuf::from("C:/synthetic")),
                    Duration::from_millis(20)
                )
                .await
                .unwrap_err(),
            "pi_work_steer_unsupported"
        );
        assert!(frames.try_recv().is_err());
    }
    #[tokio::test]
    async fn stop_and_capability_or_workspace_changes_do_not_send_or_forge_acceptance() {
        let service = PiWorkService::default();
        let (sender, mut frames, _writer) = SidecarSteering::test_sender(true);
        let run = run(&service, sender.clone());
        assert!(service
            .steer_selected(
                "run",
                REQUEST,
                "text",
                || Some(PathBuf::from("C:/other")),
                Duration::from_millis(20)
            )
            .await
            .is_err());
        run.state.lock().unwrap().engine = WorkEngine::Dsh;
        assert!(service
            .steer_selected(
                "run",
                REQUEST,
                "text",
                || Some(PathBuf::from("C:/synthetic")),
                Duration::from_millis(20)
            )
            .await
            .is_err());
        run.state.lock().unwrap().engine = WorkEngine::Thin;
        run.state
            .lock()
            .unwrap()
            .hello
            .as_mut()
            .unwrap()
            .supports_steering = false;
        assert!(service
            .steer_selected(
                "run",
                REQUEST,
                "text",
                || Some(PathBuf::from("C:/synthetic")),
                Duration::from_millis(20)
            )
            .await
            .is_err());
        run.state
            .lock()
            .unwrap()
            .hello
            .as_mut()
            .unwrap()
            .supports_steering = true;
        assert!(frames.try_recv().is_err());
        let sending = service.clone();
        let task = tokio::spawn(async move {
            sending
                .steer_selected(
                    "run",
                    REQUEST,
                    "text",
                    || Some(PathBuf::from("C:/synthetic")),
                    Duration::from_secs(1),
                )
                .await
        });
        frames.recv().await.unwrap();
        sender.stop();
        assert!(task.await.unwrap().is_err());
        assert!(run.state.lock().unwrap().instructions.is_empty());
    }
    #[test]
    fn accepted_metadata_is_separate_from_sdk_entries_and_removed_from_plain_history() {
        let mut ledger = SteeringLedger::default();
        ledger
            .reserve("run", REQUEST, "sensitive synthetic text")
            .unwrap();
        let mut state = state();
        let ack = crate::pi_sidecar::SteerAckRecord {
            result: Ok(()),
            received_at_ms: 1,
        };
        assert!(apply_known_ack(&mut ledger, &mut state, REQUEST, &ack));
        let encrypted = serde_json::to_value(PiCheckpoint {
            workspace: PathBuf::from("C:/synthetic"),
            entries: json!({"untouched":true}),
            run: Some(state.clone()),
            file_changes: None, read_observations: None,
        })
        .unwrap();
        assert_eq!(encrypted["entries"], json!({"untouched":true}));
        assert_eq!(encrypted["run"]["instructions"][0]["state"], "accepted");
        assert!(valid_restored_instructions(&state.instructions));
        let metadata = history_metadata(&state);
        let plain = serde_json::to_string(&metadata).unwrap();
        assert!(!plain.contains("sensitive synthetic text"));
        assert!(metadata.prompt.is_empty());
        state.status = "failed".into();
        assert!(!steer_eligible(
            &state,
            Path::new("C:/synthetic"),
            Some(&PathBuf::from("C:/synthetic"))
        ));
    }
    #[test]
    fn accepted_instruction_encrypts_to_checkpoint_and_restores_without_live_authority() {
        let root = std::env::temp_dir().join(format!("hub-pi-steering-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let _guard = crate::agent_tools::TestWorkspace { path: root.clone() };
        let saved_dir = root.join("saved");
        let store = crate::checkpoint::CheckpointStore::test(saved_dir.clone(), [27; 32]);
        let history = root.join("history.jsonl");
        let service = PiWorkService {
            checkpoints: Some(store.clone()), history: Some(history.clone()), ..Default::default()
        };
        let mut state = state();
        state.id = uuid::Uuid::new_v4().to_string();
        state.workspace = root.to_string_lossy().into_owned();
        let text = " synthetic-steering-private-body\n😀 ";
        let mut ledger = SteeringLedger::default();
        ledger.reserve(&state.id, REQUEST, text).unwrap();
        let ack = crate::pi_sidecar::SteerAckRecord { result: Ok(()), received_at_ms: 7 };
        assert!(apply_known_ack(&mut ledger, &mut state, REQUEST, &ack));
        let instruction = state.instructions[0].clone();
        let entries = json!([{ "type": "session", "id": "synthetic-sdk-context" }]);
        store.save(&state.id, &PiCheckpoint {
            workspace: root, entries: entries.clone(), run: None, file_changes: None, read_observations: None
        }).unwrap();
        state.status = "done".into();
        state.ended_at_ms = Some(8);
        service.record_terminal(&AtomicBool::new(false), &state);
        let saved = store.load::<PiCheckpoint>(&state.id).unwrap();
        assert_eq!(saved.entries, entries);
        let persisted = &saved.run.unwrap().instructions[0];
        assert_eq!(persisted.text, text);
        assert_eq!(persisted.request_id, instruction.request_id);
        assert_eq!(persisted.delivery_id, instruction.delivery_id);
        assert_eq!(persisted.user_message_id, instruction.user_message_id);
        let plain = std::fs::read_to_string(&history).unwrap();
        assert!(!plain.contains("synthetic-steering-private-body"));
        let metadata: PiRunState = serde_json::from_str(plain.trim()).unwrap();
        assert!(metadata.instructions.is_empty());
        assert!(metadata.prompt.is_empty());
        for file in std::fs::read_dir(&saved_dir).unwrap() {
            let bytes = std::fs::read(file.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("synthetic-steering-private-body"));
        }
        let wrong_key = crate::checkpoint::CheckpointStore::test(saved_dir, [28; 32]);
        assert!(wrong_key.load::<PiCheckpoint>(&state.id).is_none());
        let restored = PiWorkService { checkpoints: Some(store), history: Some(history), ..Default::default() };
        restored.restore_history();
        let restored_state = restored.status(&state.id).unwrap();
        assert_eq!(restored_state.instructions.len(), 1);
        let restored_instruction = &restored_state.instructions[0];
        assert_eq!(restored_instruction.text, text);
        assert_eq!(restored_instruction.delivery_id, instruction.delivery_id);
        assert_eq!(restored_instruction.user_message_id, instruction.user_message_id);
        assert_eq!(restored_instruction.accepted_at_ms, 7);
        assert!(!restored_state.supports_steering);
        assert_eq!(restored_state.prompt, "original");
        let restored_run = restored.run(&state.id).unwrap();
        assert!(restored_run.steering.is_none());
        assert!(restored_run.wait.lock().unwrap().is_none());
        assert!(restored_run.decisions.lock().unwrap().is_empty());
    }

}


#[cfg(test)]
mod comparison_launch_tests {
    use super::*;
    fn generation() -> GenerationProfile {
        GenerationProfile { temperature:0.0, max_tokens:1024, reasoning:GenerationReasoning::Off }
    }
    #[test]
    fn comparison_requires_confirmation_current_workspace_and_exact_local_model() {
        let root = Path::new("C:/synthetic");
        assert!(validate_comparison(root, Some(root), "task", "ollama/local:7b", &generation(), true).is_ok());
        assert!(validate_comparison(root, Some(root), "task", "ollama/local:7b", &generation(), false).is_err());
        assert!(validate_comparison(root, None, "task", "ollama/local:7b", &generation(), true).is_err());
        assert!(validate_comparison(root, Some(Path::new("C:/other")), "task", "ollama/local:7b", &generation(), true).is_err());
        for model in ["", "ollama/", "openai/gpt", " ollama/local:7b", "ollama/local:7b ", "ollama/../x", "ollama/x?url=http"] {
            assert!(validate_comparison(root, Some(root), "task", model, &generation(), true).is_err());
        }
        for prompt in ["".to_owned(), " \n".to_owned(), "x\0y".to_owned(), "x".repeat(MAX_PROMPT_CHARS+1)] {
            assert!(validate_comparison(root, Some(root), &prompt, "ollama/local:7b", &generation(), true).is_err());
        }
    }
    #[test]
    fn comparison_fixed_session_has_empty_caps_and_normal_dsh_gate_stays_closed() {
        for engine in [WorkEngine::Thin, WorkEngine::Dsh] {
            let spec = comparison_spec(PathBuf::from("C:/synthetic"), PathBuf::from("reviewed.mjs"), "literal prompt", "ollama/local:7b", engine);
            assert_eq!(spec.program, PathBuf::from("node"));
            assert_eq!(spec.args, vec!["reviewed.mjs", "ollama/local:7b", "literal prompt"]);
            assert_eq!(spec.env, vec![("PI_SIDECAR_CAPS".into(), "".into()), ("PI_SIDECAR_SESSION".into(), "1".into()),
                ("PI_WORK_ENGINE".into(), if engine == WorkEngine::Dsh { "dsh" } else { "thin" }.into())]);
        }
        assert_eq!(validate_engine(WorkEngine::Dsh, None).unwrap_err(), "legacy_engine_requires_resume");
        assert_eq!(validate_engine(WorkEngine::Pi, None).unwrap_err(), STANDARD_ENGINE_RETIRED);
        assert!(validate_engine(WorkEngine::Dsh, Some("saved")).is_ok());
        let old: PiRunState = serde_json::from_value(serde_json::json!({"id":"old","workspace":"fixed","script":"fixed","model":"fixed","prompt":"fixed",
            "allowWrite":false,"status":"done","hello":null,"toolCalls":[],"pendingActions":[],"agentEvents":0,"outcome":null,
            "stderrTail":"","startedAtMs":1,"endedAtMs":2})).unwrap();
        assert!(old.generation.is_none());
        assert!(serde_json::to_value(old).unwrap().get("generation").is_none());
    }
    #[tokio::test]
    async fn comparison_selected_workspace_admission_rejects_without_starting_a_run() {
        let service = PiWorkService::default();
        let leases = Arc::new(tokio::sync::Mutex::new(DevRuns::default()));
        let workspace = PathBuf::from("C:/synthetic");
        for selected in [None,Some(PathBuf::from("C:/other"))] {
            assert_eq!(launch_comparison(&service,&leases,workspace.clone(),"task","ollama/local:7b",
                WorkEngine::Dsh,generation(),true,selected).await.unwrap_err(),"pi_work_comparison_workspace_changed");
        }
        assert_eq!(launch_comparison(&service,&leases,workspace.clone(),"task","ollama/local:7b",
            WorkEngine::Dsh,generation(),false,Some(workspace.clone())).await.unwrap_err(),"pi_work_comparison_confirmation_required");
        assert!(service.list().is_empty());
        let mut leases = leases.lock().await;
        assert!(leases.reserve_work(&workspace,"guard-not-launched").is_ok());
        leases.release_work(&workspace,"guard-not-launched");
    }

    #[tokio::test]
    async fn encrypted_comparison_profile_survives_normal_resume_and_fresh_permissions() {
        let root = std::env::temp_dir().join(format!("hub-comparison-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let _guard = crate::agent_tools::TestWorkspace { path:root.clone() };
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [30;32]);
        let history = root.join("history.jsonl");
        let prior: PiRunState = serde_json::from_value(serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),
            "workspace":root.to_string_lossy(),"script":"reviewed","model":"ollama/local:7b","prompt":"prior","engine":"thin",
            "generation":generation(),"allowWrite":false,"status":"done","hello":null,"toolCalls":[],"pendingActions":[],
            "agentEvents":0,"outcome":null,"stderrTail":"","startedAtMs":1,"endedAtMs":2})).unwrap();
        store.save(&prior.id, &PiCheckpoint { workspace:root.clone(), entries:serde_json::json!([{ "type":"session", "id":"synthetic", "hubEngine":"thin" }]),
            run:Some(prior.clone()),file_changes:None,read_observations:None }).unwrap();
        let service = PiWorkService { checkpoints:Some(store),history:Some(history),..Default::default() };
        service.record_terminal(&AtomicBool::new(false), &prior);
        service.restore_history();
        assert_eq!(service.status(&prior.id).unwrap().generation, Some(generation()));
        let leases = Arc::new(tokio::sync::Mutex::new(DevRuns::default()));
        // Synthetic stdio verifies the real initialize seam; it never loads a provider SDK/model.
        let script = r#"const rl=require('node:readline').createInterface({input:process.stdin});
const send=o=>process.stdout.write(JSON.stringify(o)+'\n');
rl.once('line',line=>{const m=JSON.parse(line);const ok=m.type==='session'&&m.generation?.temperature===0&&m.generation?.maxTokens===1024&&m.generation?.reasoning==='off';
send({type:'hello',proto:1,model:'ollama/local:7b',generation:m.generation,activeTools:[],tools:[]});
send({type:'agent_done',ok});rl.close();process.stdin.destroy();});"#;
        let spec = |program: &str| SidecarSpec { program:program.into(), args:vec!["-e".into(),script.into()], workspace:root.clone(),
            env:vec![("PI_WORK_ENGINE".into(),"thin".into()),("PI_SIDECAR_SESSION".into(),"1".into())] };
        let rejected = service.start_with_resume(spec("never-spawn-this-program"), "openai/remote".into(), "resume".into(),
            true,false,false,false,Some(&prior.id),&leases,None).await.unwrap_err();
        assert_eq!(rejected,"pi_work_comparison_model_invalid");
        let started = service.start_with_resume(spec("node"), "ollama/local:7b".into(), "resume".into(),
            true,false,false,false,Some(&prior.id),&leases,None).await.unwrap();
        let finished = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = service.status(&started.id).unwrap();
                if state.status != "running" { break state; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await;
        service.cancel(&started.id,&leases).await.unwrap();
        let finished = finished.expect("synthetic resume deadline");
        assert_eq!(finished.status,"done");
        assert_eq!(finished.generation,Some(generation()));
        assert_eq!(finished.hello.unwrap().generation,Some(generation()));
        assert_eq!(finished.continuation.resumed_from.as_deref(),Some(prior.id.as_str()));
        assert!(finished.allow_write && !finished.allow_exec && !finished.allow_http && !finished.allow_test);
        assert_eq!(finished.engine,WorkEngine::Thin);
        assert!(leases.lock().await.reserve_work(&root,"after-resume").is_ok());
        leases.lock().await.release_work(&root,"after-resume");
    }
}


#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeImageStart { image_id: String, context_id: String, request_id: String }
struct NativeImageContext { images: Arc<crate::pi_images::PiImageStore>, request: Option<NativeImageStart> }
fn image_request_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.get_version_num() == 4 && id.get_variant() == uuid::Variant::RFC4122 && id.to_string() == value)
}
fn context_image_refs(entries: &serde_json::Value) -> Result<Vec<crate::pi_images::ImageReference>, String> {
    let Some(value) = entries.as_array().and_then(|items| items.first()).and_then(|header| header.get("hubImageRefs")) else { return Ok(Vec::new()); };
    let refs: Vec<crate::pi_images::ImageReference> = serde_json::from_value(value.clone()).map_err(|_| "pi_image_invalid_reference")?;
    let ids: std::collections::HashSet<_> = refs.iter().map(|image| &image.id).collect();
    if refs.len() > 4 || refs.len() != ids.len() || refs.iter().any(|image| !image_request_uuid(&image.id)) { return Err("pi_image_invalid_reference".into()); }
    Ok(refs)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageCapability { pub model: String, pub ready: bool, pub supported: bool }

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageCapabilityEnvelope {
    #[serde(rename = "type")] kind: String,
    model: String, ready: bool, supported: bool,
}

fn image_model_name(model: &str) -> bool {
    !model.is_empty() && model.len() <= 64 && !model.contains("..")
        && model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:/-".contains(&byte))
        && model.split_once('/').is_some_and(|(provider, id)| !provider.is_empty() && !id.is_empty())
}

pub(crate) async fn image_capability(model: &str) -> Result<ImageCapability, String> {
    use tokio::io::AsyncReadExt;
    if !image_model_name(model) { return Err("pi_image_invalid_request".into()); }
    let script = resolve_script(None)?;
    let mut command = tokio::process::Command::new("node");
    #[cfg(windows)] command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let probe = crate::pi_sidecar::SidecarSpec { program: "node".into(), args: Vec::new(), workspace: PathBuf::new(), env: Vec::new() };
    if let Some(cache) = crate::pi_sidecar::node_compile_cache(&probe) { command.env("NODE_COMPILE_CACHE", cache); }
    let mut child = command.arg(script).arg("--image-capability").arg(model)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()).kill_on_drop(true).spawn()
        .map_err(|_| "pi_image_unavailable")?;
    let mut stdout = child.stdout.take().ok_or("pi_image_unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut bytes = Vec::new();
        (&mut stdout).take(65537).read_to_end(&mut bytes).await.map_err(|_| "pi_image_unavailable")?;
        if bytes.len() > 65536 { return Err("pi_image_unavailable"); }
        if !child.wait().await.map_err(|_| "pi_image_unavailable")?.success() { return Err("pi_image_unavailable"); }
        let reply: ImageCapabilityEnvelope = serde_json::from_slice(&bytes).map_err(|_| "pi_image_unavailable")?;
        if reply.kind != "imageCapability" || reply.model != model { return Err("pi_image_unavailable"); }
        Ok(ImageCapability { model: reply.model, ready: reply.ready, supported: reply.supported })
    }).await.map_err(|_| "pi_image_unavailable")?;
    result.map_err(str::to_owned)
}

fn native_image_window(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if window.label() != "main" || !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImagePrepareInput {
    model: String, context_id: String, name: String, mime_type: String, data: String,
}

fn image_input_bytes(input: &ImagePrepareInput) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if !image_model_name(&input.model) || !image_request_uuid(&input.context_id)
        || input.name.trim().is_empty() || input.name.encode_utf16().count() > 255
        || input.name.chars().any(|value| value.is_control() || matches!(value, '/' | '\\'))
        || !matches!(input.mime_type.as_str(), "image/png" | "image/jpeg")
        || input.data.is_empty() || input.data.len() > 4 * crate::image_validation::MAX_IMAGE_BYTES.div_ceil(3) {
        return Err("pi_image_invalid_request".into());
    }
    let bytes = STANDARD.decode(&input.data).map_err(|_| "pi_image_invalid_request")?;
    if bytes.len() > crate::image_validation::MAX_IMAGE_BYTES || STANDARD.encode(&bytes) != input.data {
        return Err("pi_image_invalid_request".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn pi_work_image_capability(window: tauri::Webview, model: String) -> Result<ImageCapability, String> {
    native_image_window(&window)?;
    image_capability(&model).await
}

#[tauri::command]
pub async fn pi_work_prepare_image(window: tauri::Webview, input: ImagePrepareInput,
    images: tauri::State<'_, Arc<crate::pi_images::PiImageStore>>) -> Result<crate::pi_images::PreparedImage, String> {
    native_image_window(&window)?;
    let workspace = crate::dev_cli::workspace().ok_or("pi_image_scope_changed")?;
    let bytes = image_input_bytes(&input)?;
    let capability = image_capability(&input.model).await?;
    if !capability.ready || !capability.supported { return Err("pi_image_model_unsupported".into()); }
    let image = tokio::task::spawn_blocking(move || crate::image_validation::prepare_image(&bytes))
        .await.map_err(|_| "image_decode_unavailable")?.map_err(str::to_owned)?;
    if image.metadata().mime_type != input.mime_type { return Err("pi_image_invalid_request".into()); }
    if crate::dev_cli::workspace().as_ref() != Some(&workspace) { return Err("pi_image_scope_changed".into()); }
    images.prepare(&input.model, &input.context_id, &input.name, workspace, image).map_err(str::to_owned)
}

#[derive(serde::Serialize)]
pub struct ImageReleaseReply { released: bool }

#[tauri::command]
pub async fn pi_work_release_image(window: tauri::Webview, image_id: String, context_id: String,
    images: tauri::State<'_, Arc<crate::pi_images::PiImageStore>>) -> Result<ImageReleaseReply, String> {
    native_image_window(&window)?;
    images.release(&image_id, &context_id).map(|released| ImageReleaseReply { released }).map_err(str::to_owned)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewReply { attachment: crate::pi_images::ImageAttachment, sha256: String, data: String }

#[tauri::command]
pub async fn pi_work_image_preview(window: tauri::Webview, image_id: String,
    service: tauri::State<'_, PiWorkService>, images: tauri::State<'_, Arc<crate::pi_images::PiImageStore>>)
    -> Result<ImagePreviewReply, String> {
    native_image_window(&window)?;
    let run = service.list().into_iter().find(|run| run.image_context_refs.iter().any(|image| image.id == image_id))
        .ok_or("pi_image_unknown")?;
    let reference = run.image_context_refs.iter().find(|image| image.id == image_id).ok_or("pi_image_unknown")?;
    let canonical = service.run(&run.id).ok_or("pi_image_unknown")?.workspace.clone();
    let image = images.load(reference, &canonical).map_err(str::to_owned)?;
    Ok(ImagePreviewReply { attachment: image.attachment(), sha256: reference.sha256.clone(), data: image.data_base64().to_owned() })
}

#[cfg(test)]
mod restore_image_history_contract_tests {
    use super::*;
    use serde_json::json;

    const IMAGE: &str = "20000000-0000-4000-8000-000000000001";
    const OLD_IMAGE: &str = "20000000-0000-4000-8000-000000000002";
    const REQUEST: &str = "30000000-0000-4000-8000-000000000001";

    fn fixture() -> (crate::agent_tools::TestWorkspace, PathBuf, PiRunState) {
        let directory = std::env::temp_dir().join(format!("pi-image-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let root = directory.canonicalize().unwrap();
        let guard = crate::agent_tools::TestWorkspace { path: root.clone() };
        let state = serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4().to_string(), "workspace": non_verbatim(root.clone()),
            "script":"synthetic", "model":"ollama/synthetic", "prompt":"synthetic prompt", "engine":"thin",
            "allowWrite":false, "status":"done", "hello":null, "toolCalls":[],
            "pendingActions":[], "agentEvents":0, "outcome":null, "stderrTail":"",
            "startedAtMs":1,"endedAtMs":2,
            "imageAttachments":[
                {"type":"image","id":IMAGE,"name":"synthetic.png","mimeType":"image/png","sizeBytes":12},
                {"type":"image","id":OLD_IMAGE,"name":"older.jpg","mimeType":"image/jpeg","sizeBytes":14}
            ],
            "imageContextRefs":[
                {"id":IMAGE,"mimeType":"image/png","sizeBytes":12,"sha256":"a".repeat(64)},
                {"id":OLD_IMAGE,"mimeType":"image/jpeg","sizeBytes":14,"sha256":"b".repeat(64)}
            ],
            "promptImageIds":[IMAGE],"reattachedImageIds":[OLD_IMAGE],"imageRequestId":REQUEST
        })).unwrap();
        (guard, non_verbatim(root), state)
    }

    fn restore(root: &Path, state: &PiRunState, entries: serde_json::Value, checkpoint_workspace: &Path) -> PiWorkService {
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [51;32]);
        store.save(&state.id, &PiCheckpoint {
            workspace: checkpoint_workspace.to_path_buf(), entries, run: Some(state.clone()), file_changes: None, read_observations: None,
        }).unwrap();
        let history = root.join("history.jsonl");
        append_history(&history, state).unwrap();
        let service = PiWorkService { history: Some(history), checkpoints: Some(store), ..Default::default() };
        service.restore_history();
        service
    }

    fn header(state: &PiRunState) -> serde_json::Value {
        json!([{"type":"session","id":"synthetic-session","hubEngine":"thin","hubImageRefs":state.image_context_refs}])
    }

    #[test]
    fn encrypted_terminal_metadata_survives_redacted_history_and_same_context_resume() {
        let (_guard, root, state) = fixture();
        let history = root.join("history.jsonl");
        let store = crate::checkpoint::CheckpointStore::test(root.join("saved"), [51;32]);
        let entries = header(&state);
        store.save(&state.id, &PiCheckpoint { workspace:root.clone(), entries:entries.clone(),run:None,file_changes:None,read_observations:None }).unwrap();
        let service = PiWorkService {history:Some(history.clone()),checkpoints:Some(store.clone()),..Default::default()};
        service.record_terminal(&AtomicBool::new(false), &state);
        let public = std::fs::read_to_string(&history).unwrap();
        assert!(!public.contains(IMAGE)); assert!(!public.contains("synthetic.png")); assert!(!public.contains(REQUEST));
        let restored = PiWorkService {history:Some(history),checkpoints:Some(store),..Default::default()};
        restored.restore_history();
        let actual = restored.status(&state.id).unwrap();
        assert_eq!(serde_json::to_value(&actual.image_attachments).unwrap(),serde_json::to_value(&state.image_attachments).unwrap());
        assert_eq!(actual.image_context_refs,state.image_context_refs);
        assert_eq!(actual.prompt_image_ids,state.prompt_image_ids);
        assert_eq!(actual.reattached_image_ids,state.reattached_image_ids);
        assert_eq!(actual.image_request_id,state.image_request_id);
        assert!(actual.continuation.available);
        assert_eq!(restored.resume_checkpoint(&state.id,&root).unwrap().entries,entries);
    }

    #[test]
    fn null_or_mismatched_header_keeps_owned_preview_metadata_without_resume() {
        for entries in [serde_json::Value::Null,json!([{"type":"session","hubEngine":"thin","hubImageRefs":[]}])] {
            let (_guard,root,state)=fixture();
            let service=restore(&root,&state,entries,&root);
            let actual=service.status(&state.id).unwrap();
            assert_eq!(actual.image_context_refs,state.image_context_refs);
            assert_eq!(actual.image_attachments.len(),2);
            assert!(!actual.continuation.available);
            assert_eq!(actual.continuation.error.as_deref(),Some("pi_image_checkpoint_incomplete"));
            assert!(service.resume_checkpoint(&state.id,&root).is_err());
        }
    }

    #[test]
    fn different_workspace_engine_or_identity_cannot_authorize_images() {
        for variant in 0..4 {
            let (_guard,root,mut state)=fixture();
            let entries=header(&state);
            let checkpoint_workspace=if variant==0 {root.join("other")} else {root.clone()};
            if variant==1 {state.engine=WorkEngine::Dsh;}
            let store=crate::checkpoint::CheckpointStore::test(root.join("saved"),[51;32]);
            let mut saved=state.clone();
            if variant==2 {saved.workspace=root.join("other").to_string_lossy().into_owned();}
            if variant==3 {saved.id=uuid::Uuid::new_v4().to_string();}
            store.save(&state.id,&PiCheckpoint{workspace:checkpoint_workspace,entries,run:Some(saved),file_changes:None,read_observations:None}).unwrap();
            let history=root.join("history.jsonl");append_history(&history,&state).unwrap();
            let service=PiWorkService{history:Some(history),checkpoints:Some(store),..Default::default()};service.restore_history();
            let actual=service.status(&state.id).unwrap();
            assert!(actual.image_attachments.is_empty());assert!(actual.image_context_refs.is_empty());
            assert!(!actual.continuation.available);assert_eq!(actual.continuation.error.as_deref(),Some("pi_image_restore_invalid"));
        }
    }

    #[test]
    fn invalid_widths_duplicates_hashes_and_metadata_pairs_fail_closed() {
        for variant in 0..9 {
            let (_guard,root,mut state)=fixture();
            match variant {
                0=>state.image_attachments[0].size_bytes+=1,
                1=>state.image_context_refs[0].sha256="A".repeat(64),
                2=>state.image_context_refs[0].size_bytes=crate::image_validation::MAX_IMAGE_BYTES+1,
                3=>state.image_attachments[0].name="🌿".repeat(128),
                4=>state.image_context_refs.push(state.image_context_refs[0].clone()),
                5=>state.prompt_image_ids.push(OLD_IMAGE.into()),
                6=>state.reattached_image_ids.push(IMAGE.into()),
                7=>state.image_request_id=None,
                _=>state.image_attachments[0].name="nested/file.png".into(),
            }
            let service=restore(&root,&state,header(&state),&root);
            let actual=service.status(&state.id).unwrap();
            assert!(actual.image_attachments.is_empty());assert!(actual.image_context_refs.is_empty());
            assert!(!actual.continuation.available);
            assert_eq!(actual.continuation.error.as_deref(),Some("pi_image_restore_invalid"));
        }
    }

    #[test]
    fn unknown_body_key_in_metadata_or_sdk_reference_never_authorizes_preview() {
        for variant in 0..2 {
            let (_guard,root,state)=fixture();
            let store=crate::checkpoint::CheckpointStore::test(root.join("saved"),[51;32]);
            let mut saved=json!({"workspace":root,"entries":header(&state),"run":state});
            if variant==0 {saved["run"]["imageAttachments"][0]["data"]="synthetic-forbidden-body".into();}
            else {saved["run"]["imageContextRefs"][0]["dataBase64"]="synthetic-forbidden-body".into();}
            store.save(&state.id,&saved).unwrap();
            let history=root.join("history.jsonl");append_history(&history,&state).unwrap();
            let service=PiWorkService{history:Some(history),checkpoints:Some(store),..Default::default()};service.restore_history();
            let actual=service.status(&state.id).unwrap();
            assert!(actual.image_context_refs.is_empty());assert!(actual.image_attachments.is_empty());
            assert!(!actual.continuation.available);assert!(service.resume_checkpoint(&state.id,&root).is_err());
        }
    }

    #[test]
    fn forged_public_images_without_checkpoint_are_ignored_and_legacy_text_is_unchanged() {
        let (_guard,root,mut state)=fixture();
        let history=root.join("history.jsonl");std::fs::write(&history,format!("{}\n",serde_json::to_string(&state).unwrap())).unwrap();
        let service=PiWorkService{history:Some(history),..Default::default()};service.restore_history();
        let actual=service.status(&state.id).unwrap();
        assert!(actual.image_attachments.is_empty());assert!(!actual.continuation.available);
        state.image_attachments.clear();state.image_context_refs.clear();state.prompt_image_ids.clear();
        state.reattached_image_ids.clear();state.image_request_id=None;
        let service=restore(&root,&state,json!([{"type":"session","id":"legacy","hubEngine":"thin"}]),&root);
        let actual=service.status(&state.id).unwrap();
        assert!(actual.continuation.available);assert!(actual.image_attachments.is_empty());
        assert_eq!(service.resume_checkpoint(&state.id,&root).unwrap().entries[0]["id"],"legacy");
    }

    /// 2026-10-18 (owner-approved): a run saved by the deleted standard engine stays viewable
    /// (prompt, outcome, final text) but is never resumable, even with an intact checkpoint.
    #[test]
    fn saved_standard_runs_stay_viewable_and_are_never_resumable() {
        let (_guard,root,mut state)=fixture();
        state.engine=WorkEngine::Pi;
        state.image_attachments.clear();state.image_context_refs.clear();state.prompt_image_ids.clear();
        state.reattached_image_ids.clear();state.image_request_id=None;
        state.outcome=Some(PiOutcome{verified:false,ok:true,exit_code:Some(0),error:None});
        state.final_output="standard answer".into();
        let service=restore(&root,&state,json!([{"type":"session","id":"legacy"}]),&root);
        let actual=service.status(&state.id).unwrap();
        assert_eq!(actual.engine,WorkEngine::Pi);
        assert_eq!(actual.prompt,"synthetic prompt");
        assert_eq!(actual.final_output,"standard answer");
        assert!(actual.outcome.as_ref().is_some_and(|outcome| outcome.ok));
        assert!(!actual.continuation.available);
        assert_eq!(actual.continuation.error.as_deref(),Some(STANDARD_ENGINE_RETIRED));
        assert_eq!(service.resume_checkpoint(&state.id,&root).err().as_deref(),Some(STANDARD_ENGINE_RETIRED));
        assert_eq!(service.saved_engine(Some(&state.id)),Some(WorkEngine::Pi));
        assert_eq!(validate_engine(WorkEngine::for_start(None,service.saved_engine(Some(&state.id))),Some(&state.id)).unwrap_err(),STANDARD_ENGINE_RETIRED);
    }
}

#[cfg(all(test, windows))]
mod image_sdk_integration_tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const MODEL: &str = "fixture/image";
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const ANSWER: &str = "SYNTHETIC IMAGE VERIFIED";

    struct RestoreEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl RestoreEnv {
        fn capture() -> Self {
            Self(
                [
                    "APPDATA",
                    "HUB_DEV_WORKSPACE",
                    "PI_CODING_AGENT_DIR",
                    "PI_WORK_SIDECAR",
                    "PI_POC_SCENARIO",
                    "GIT_CONFIG_GLOBAL",
                    "GIT_CONFIG_NOSYSTEM",
                    "GIT_TEMPLATE_DIR",
                ]
                .into_iter()
                .map(|name| (name, std::env::var_os(name)))
                .collect(),
            )
        }
    }
    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    struct FakeProvider {
        port: u16,
        requests: Arc<Mutex<Vec<bool>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl FakeProvider {
        async fn new() -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = requests.clone();
            let task = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        connection = listener.accept() => {
                            let Ok((stream, address)) = connection else { break; };
                            assert!(address.ip().is_loopback());
                            let captured = captured.clone();
                            connections.spawn(async move { Self::reply(stream, captured).await; });
                        }
                        Some(_) = connections.join_next(), if !connections.is_empty() => {}
                    }
                }
            });
            Self {
                port,
                requests,
                task,
            }
        }
        async fn reply(mut stream: tokio::net::TcpStream, requests: Arc<Mutex<Vec<bool>>>) {
            let mut bytes = Vec::new();
            let mut block = [0u8; 8192];
            let request = tokio::time::timeout(Duration::from_secs(15), async {
                let (end, length) = loop {
                    let count = stream.read(&mut block).await.ok()?;
                    if count == 0 {
                        return None;
                    }
                    bytes.extend_from_slice(&block[..count]);
                    if bytes.len() > 1024 * 1024 {
                        return None;
                    }
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = std::str::from_utf8(&bytes[..end]).ok()?;
                        if !headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n") {
                            return None;
                        }
                        let length = headers
                            .lines()
                            .filter_map(|line| line.split_once(':'))
                            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))?
                            .1
                            .trim()
                            .parse::<usize>()
                            .ok()?;
                        if length > 1024 * 1024 {
                            return None;
                        }
                        break (end + 4, length);
                    }
                };
                while bytes.len() < end + length {
                    let count = stream.read(&mut block).await.ok()?;
                    if count == 0 {
                        return None;
                    }
                    bytes.extend_from_slice(&block[..count]);
                    if bytes.len() > 1024 * 1024 {
                        return None;
                    }
                }
                serde_json::from_slice::<Value>(&bytes[end..end + length]).ok()
            })
            .await
            .ok()
            .flatten();
            let valid = request.as_ref().is_some_and(|body| {
                let Some(messages) = body["messages"].as_array() else {
                    return false;
                };
                let golden = STANDARD.decode(PNG).unwrap();
                let sha = Sha256::digest(&golden);
                let images = messages
                    .iter()
                    .filter(|message| message["role"] == "user")
                    .filter_map(|message| message["content"].as_array())
                    .flatten()
                    .filter(|part| part["type"] == "image_url")
                    .collect::<Vec<_>>();
                !images.is_empty()
                    && images.iter().all(|part| {
                        part["image_url"]["url"]
                            .as_str()
                            .and_then(|url| url.strip_prefix("data:image/png;base64,"))
                            .and_then(|data| STANDARD.decode(data).ok())
                            .is_some_and(|actual| actual == golden && Sha256::digest(actual) == sha)
                    })
            });
            requests.lock().unwrap().push(valid);
            let (status, content_type, body) = if valid {
                let first = json!({"id":"fixture-chat","object":"chat.completion.chunk","created":1,"model":"image",
                    "choices":[{"index":0,"delta":{"role":"assistant","content":ANSWER},"finish_reason":null}]});
                let last = json!({"id":"fixture-chat","object":"chat.completion.chunk","created":1,"model":"image",
                    "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":32,"completion_tokens":8,"total_tokens":40}});
                (
                    "200 OK",
                    "text/event-stream",
                    format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
                )
            } else {
                (
                    "400 Bad Request",
                    "application/json",
                    "{\"error\":{\"message\":\"synthetic request rejected\"}}".into(),
                )
            };
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes()).await;
        }
        fn count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
        fn assert_images(&self) {
            let rows = self.requests.lock().unwrap();
            assert!(!rows.is_empty());
            assert!(
                rows.iter().all(|value| *value),
                "fake provider rejected a non-golden image"
            );
        }
    }
    impl Drop for FakeProvider {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn terminal(
        service: &PiWorkService,
        run: &PiRunState,
        leases: &Arc<tokio::sync::Mutex<DevRuns>>,
    ) -> PiRunState {
        let result = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let state = service.status(&run.id).unwrap();
                if state.status != "running" {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        let cleanup =
            tokio::time::timeout(Duration::from_secs(10), service.cancel(&run.id, leases)).await;
        assert!(
            cleanup.is_ok_and(|value| value.is_ok()),
            "owned sidecar cleanup failed"
        );
        result.expect("synthetic SDK image deadline")
    }
    fn plaintext_absent(directory: &Path, needle: &[u8]) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(
                !bytes.windows(needle.len()).any(|part| part == needle),
                "synthetic private bytes found in encrypted fixture"
            );
        }
    }

    /// 2026-10-18: image prompts run thin (the only engine), with type/size/digest checks,
    /// encrypted refs and restart/resume/compaction.
    #[tokio::test]
    async fn thin_image_checkpoint_restart_resume_and_compaction() {
        image_checkpoint_flow(WorkEngine::Thin).await;
    }

    async fn image_checkpoint_flow(engine: WorkEngine) {
        let _env_lock = crate::local_cli::ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let path =
            std::env::temp_dir().join(format!("hub-pi-image-integration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let root = path.canonicalize().unwrap();
        let _workspace = crate::agent_tools::TestWorkspace { path: root.clone() };
        let _restore = RestoreEnv::capture();
        let agent_dir = root.join("agent-dir");
        std::fs::create_dir(&agent_dir).unwrap();
        let empty_config = root.join("git-empty-config");
        std::fs::write(&empty_config, "").unwrap();
        let templates = root.join("git-empty-templates");
        std::fs::create_dir(&templates).unwrap();
        std::env::set_var("APPDATA", root.join("appdata"));
        std::env::set_var("PI_CODING_AGENT_DIR", non_verbatim(agent_dir.clone()));
        std::env::remove_var("PI_WORK_SIDECAR");
        std::env::remove_var("PI_POC_SCENARIO");
        std::env::remove_var("HUB_DEV_WORKSPACE");
        std::env::set_var("GIT_CONFIG_GLOBAL", non_verbatim(empty_config));
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("GIT_TEMPLATE_DIR", non_verbatim(templates));
        assert!(crate::local_cli::quiet_std_command("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(non_verbatim(root.clone()))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success());
        crate::dev_cli::set_workspace(&root.to_string_lossy()).unwrap();
        assert_eq!(crate::dev_cli::workspace().as_ref(), Some(&root));
        let provider = FakeProvider::new().await;
        std::fs::write(agent_dir.join("models.json"), serde_json::to_vec(&json!({"providers":{"fixture":{
            "baseUrl":format!("http://127.0.0.1:{}/v1", provider.port),"api":"openai-completions","apiKey":"SYNTHETIC-NOT-CREDENTIAL",
            "models":[{"id":"image","name":"Synthetic image fixture","input":["text","image"],"reasoning":false,
                "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":8192,"maxTokens":1024}]
        }}})).unwrap()).unwrap();
        std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
        let capability = image_capability(MODEL)
            .await
            .expect("registered synthetic image capability");
        assert!(capability.ready && capability.supported);
        assert_eq!(provider.count(), 0, "readonly capability must not generate");
        let script = resolve_script(None).unwrap();
        let packaged = non_verbatim(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../vendor/pi-sidecar/pi-sidecar.mjs")
                .canonicalize()
                .unwrap(),
        );
        assert_eq!(script, packaged);
        let spec = |prompt: &str| SidecarSpec {
            program: "node".into(),
            args: vec![
                script.to_string_lossy().into_owned(),
                MODEL.into(),
                prompt.into(),
            ],
            workspace: root.clone(),
            env: vec![
                ("PI_SIDECAR_SESSION".into(), "1".into()),
                ("PI_SIDECAR_CAPS".into(), "".into()),
                ("PI_WORK_ENGINE".into(), engine.env_value().into()),
                (
                    "PI_CODING_AGENT_DIR".into(),
                    non_verbatim(agent_dir.clone())
                        .to_string_lossy()
                        .into_owned(),
                ),
            ],
        };
        let store = crate::checkpoint::CheckpointStore::test(root.join("sessions"), [74; 32]);
        let image_store = crate::checkpoint::CheckpointStore::test(root.join("images"), [75; 32]);
        let images = Arc::new(crate::pi_images::PiImageStore::with_test_store(
            image_store.clone(),
        ));
        let bytes = STANDARD.decode(PNG).unwrap();
        assert_eq!(bytes.len(), 69);
        let image = crate::image_validation::prepare_image(&bytes).unwrap();
        let golden_sha = image.metadata().sha256;
        let context_id = uuid::Uuid::new_v4().to_string();
        let prepared = images
            .prepare(
                MODEL,
                &context_id,
                "SYNTHETIC-PRIVATE-NAME.png",
                root.clone(),
                image,
            )
            .ok()
            .unwrap();
        let request_id = uuid::Uuid::new_v4().to_string();
        let attachment_id = prepared.attachment.id.clone();
        let history = root.join("history.jsonl");
        let service = PiWorkService {
            checkpoints: Some(store.clone()),
            history: Some(history.clone()),
            ..Default::default()
        };
        let leases = Arc::new(tokio::sync::Mutex::new(DevRuns::default()));
        let first = service
            .start_core_images(
                spec("SYNTHETIC-PRIVATE-FIRST-PROMPT"),
                MODEL.into(),
                "SYNTHETIC-PRIVATE-FIRST-PROMPT".into(),
                false,
                false,
                false,
                false,
                None,
                &leases,
                None,
                None,
                Some(NativeImageContext {
                    images: images.clone(),
                    request: Some(NativeImageStart {
                        image_id: attachment_id.clone(),
                        context_id,
                        request_id: request_id.clone(),
                    }),
                }),
             None,)
            .await
            .unwrap();
        let finished = terminal(&service, &first, &leases).await;
        assert_eq!(finished.status, "done", "{}", finished.stderr_tail);
        assert!(finished.outcome.as_ref().is_some_and(|outcome| outcome.ok));
        assert!(finished.image_receipt_valid);
        assert_eq!(finished.prompt_image_ids, vec![attachment_id.clone()]);
        assert!(finished.reattached_image_ids.is_empty());
        assert_eq!(
            finished.image_request_id.as_deref(),
            Some(request_id.as_str())
        );
        assert_eq!(finished.image_context_refs[0].sha256, golden_sha);
        assert!(finished.tool_calls.is_empty() && finished.pending_actions.is_empty());
        assert!(finished.final_output.contains(ANSWER));
        let saved = store.load::<PiCheckpoint>(&first.id).unwrap();
        assert!(valid_context(&saved.entries));
        assert_eq!(context_engine(&saved.entries), Some(engine));
        assert_eq!(finished.engine, engine);
        assert_eq!(saved.entries[0]["type"], "session");
        assert_eq!(saved.entries[0]["hubImageRefs"][0]["id"], attachment_id);
        assert!(saved
            .entries
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["message"]["content"]
                .as_array()
                .is_some_and(|items| items
                    .iter()
                    .any(|part| part["type"] == "hub_image_ref" && part["sha256"] == golden_sha))));
        assert!(!serde_json::to_string(&saved.entries).unwrap().contains(PNG));
        for needle in [
            PNG,
            "SYNTHETIC-PRIVATE-FIRST-PROMPT",
            "SYNTHETIC-PRIVATE-NAME.png",
        ] {
            assert!(!std::fs::read_to_string(&history).unwrap().contains(needle));
        }
        plaintext_absent(&root.join("sessions"), PNG.as_bytes());
        plaintext_absent(&root.join("images"), PNG.as_bytes());
        plaintext_absent(&root.join("images"), &bytes);
        let restart = PiWorkService {
            checkpoints: Some(store.clone()),
            history: Some(history),
            ..Default::default()
        };
        restart.restore_history();
        assert!(restart
            .run(&first.id)
            .unwrap()
            .wait
            .lock()
            .unwrap()
            .is_none());
        // The UI path omits Windows' verbatim prefix; preview must use PiRun's canonical path.
        let canonical_preview_root = restart.run(&first.id).unwrap().workspace.clone();
        assert_eq!(canonical_preview_root, root);
        assert_ne!(canonical_preview_root, PathBuf::from(&finished.workspace));
        let canonical_preview = images
            .load(&finished.image_context_refs[0], &canonical_preview_root)
            .ok()
            .unwrap();
        assert_eq!(canonical_preview.data_base64(), PNG);
        assert!(images
            .load(
                &finished.image_context_refs[0],
                &PathBuf::from(&finished.workspace)
            )
            .is_err());
        let before = provider.count();
        let resumed = restart
            .start_core_images(
                spec("SYNTHETIC-TEXT-RESUME"),
                MODEL.into(),
                "SYNTHETIC-TEXT-RESUME".into(),
                false,
                false,
                false,
                false,
                Some(&first.id),
                &leases,
                None,
                None,
                Some(NativeImageContext {
                    images: images.clone(),
                    request: None,
                }),
             None,)
            .await
            .unwrap();
        let resumed = terminal(&restart, &resumed, &leases).await;
        assert_eq!(resumed.status, "done");
        assert!(resumed.image_receipt_valid);
        assert!(resumed.prompt_image_ids.is_empty());
        assert!(resumed.reattached_image_ids.is_empty());
        assert!(provider.count() > before);
        let count = provider.count();
        let mut corrupt = store.load::<PiCheckpoint>(&first.id).unwrap();
        corrupt.entries[0]["hubImageRefs"][0]["sha256"] = json!("f".repeat(64));
        store.save(&first.id, &corrupt).unwrap();
        assert!(restart
            .start_core_images(
                spec("must-not-generate"),
                MODEL.into(),
                "must-not-generate".into(),
                false,
                false,
                false,
                false,
                Some(&first.id),
                &leases,
                None,
                None,
                Some(NativeImageContext {
                    images: images.clone(),
                    request: None
                })
             ,None)
            .await
            .is_err());
        assert_eq!(provider.count(), count);
        store.save(&first.id, &saved).unwrap();
        let record_path = root.join("images").join(format!("{attachment_id}.jkcp"));
        let encrypted = std::fs::read(&record_path).unwrap();
        std::fs::remove_file(&record_path).unwrap();
        assert!(restart
            .start_core_images(
                spec("missing-must-not-generate"),
                MODEL.into(),
                "missing-must-not-generate".into(),
                false,
                false,
                false,
                false,
                Some(&first.id),
                &leases,
                None,
                None,
                Some(NativeImageContext {
                    images: images.clone(),
                    request: None
                })
             ,None)
            .await
            .is_err());
        assert_eq!(provider.count(), count);
        std::fs::write(&record_path, encrypted).unwrap();
        let mut compacted = store.load::<PiCheckpoint>(&first.id).unwrap();
        compacted.entries = json!([saved.entries[0].clone()]);
        store.save(&first.id, &compacted).unwrap();
        let after_compaction = restart
            .start_core_images(
                spec("SYNTHETIC-COMPACTED-RESUME"),
                MODEL.into(),
                "SYNTHETIC-COMPACTED-RESUME".into(),
                false,
                false,
                false,
                false,
                Some(&first.id),
                &leases,
                None,
                None,
                Some(NativeImageContext {
                    images: images.clone(),
                    request: None,
                }),
             None,)
            .await
            .unwrap();
        let after_compaction = terminal(&restart, &after_compaction, &leases).await;
        assert_eq!(after_compaction.status, "done");
        assert!(after_compaction.image_receipt_valid);
        assert!(after_compaction.prompt_image_ids.is_empty());
        assert_eq!(after_compaction.reattached_image_ids, vec![attachment_id]);
        provider.assert_images();
        assert!(leases
            .lock()
            .await
            .reserve_work(&root, "lease-cleanup-proof")
            .is_ok());
        leases
            .lock()
            .await
            .release_work(&root, "lease-cleanup-proof");
    }
}

#[path = "pi_best_of.rs"]
pub(crate) mod best_of;
#[path = "pi_work_queue.rs"]
pub(crate) mod queue;
#[path = "pi_work_queue_runtime.rs"]
pub(crate) mod queue_runtime;
