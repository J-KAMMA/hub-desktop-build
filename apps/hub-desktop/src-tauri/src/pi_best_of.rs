//! Best-of-N with test selection (owner-approved 2026-10-18, "最強ハーネス").
//!
//! An opt-in Pi run option: N (2-3) independent attempts of the same prompt,
//! each a normal Pi run in its own scratch copy of the workspace with the
//! declared verification command. The user's workspace is not touched while
//! attempts run. Selection: among attempts whose Hub-run verification passed
//! (`outcome.verified`), the fewest changed lines wins (ties: lowest index).
//! Only that attempt's file changes are then applied to the real workspace,
//! each as an ordinary `hub_write` parked on the operator's approval with the
//! usual before/after preview, and the declared command runs once more in the
//! real workspace; only that last Hub-run pass sets `verified` on the parent.
//! If no attempt passes, nothing is applied and the best attempt's diff is
//! kept in the run view for review.
//!
//! Budget: the start must echo the N-attempt token estimate the operator was
//! shown (`estimateTokens`), and an attempt whose processed tokens exceed the
//! per-attempt cap is cancelled. Cancelling the parent cancels every attempt
//! and removes the scratch copies.
use super::*;
use crate::{pi_sidecar::hub_executor_sharing_files, verification::VerificationCommand};
use serde_json::json;

pub const MIN_ATTEMPTS: u32 = 2;
pub const MAX_ATTEMPTS: u32 = 3;
/// Default per-attempt cap on processed tokens (input + output + cache read/write).
pub const DEFAULT_TOKEN_CAP: u64 = 500_000;
const MIN_TOKEN_CAP: u64 = 1_000;
const MAX_TOKEN_CAP: u64 = 5_000_000;
/// Scratch copies are plain copies; a workspace past these bounds is refused
/// before any attempt starts rather than half copied.
const MAX_COPY_FILES: usize = 50_000;
const MAX_COPY_BYTES: u64 = 1 << 30;
/// Build caches and VCS metadata stay out of the copies.
const SKIPPED_DIRS: [&str; 3] = [".git", ".hub-local-runner", "target"];
const MAX_REVIEW_DIFF_CHARS: usize = 64 * 1024;
const MONITOR_TICK: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BestOfRequest {
    pub attempts: u32,
    #[serde(default)]
    pub token_cap: Option<u64>,
    /// `maxTokens` of the estimate the operator was shown. A start whose figure
    /// differs is refused, so N attempts never start unseen.
    pub estimate_tokens: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestOfEstimate {
    pub attempts: u32,
    pub token_cap_per_attempt: u64,
    pub max_tokens: u64,
}

pub fn estimate(attempts: u32, token_cap: Option<u64>) -> Result<BestOfEstimate, String> {
    if !(MIN_ATTEMPTS..=MAX_ATTEMPTS).contains(&attempts) {
        return Err("best_of_attempts_invalid".into());
    }
    let cap = token_cap.unwrap_or(DEFAULT_TOKEN_CAP);
    if !(MIN_TOKEN_CAP..=MAX_TOKEN_CAP).contains(&cap) {
        return Err("best_of_token_cap_invalid".into());
    }
    Ok(BestOfEstimate { attempts, token_cap_per_attempt: cap, max_tokens: cap * u64::from(attempts) })
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestOfAttempt {
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// pending | running | done | failed | cancelled
    pub status: String,
    /// The attempt's own Hub-run verification passed.
    pub verified: bool,
    pub tokens: u64,
    /// Cancelled for exceeding the per-attempt token cap.
    pub capped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_lines: Option<u64>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestOfState {
    pub estimate: BestOfEstimate,
    /// copying | attempts | applying | verifying | applied | none_passed |
    /// denied | conflict | failed
    pub phase: String,
    pub attempts: Vec<BestOfAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<u32>,
    #[serde(default)]
    pub applied_files: Vec<String>,
    /// The best attempt's diff when none passed: shown for review, never
    /// applied. Content-class: cleared from plain history.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub review_diff: String,
}

pub(super) fn scratch_root(id: &str) -> PathBuf {
    std::env::temp_dir().join("jkamma-hub-best-of").join(id)
}

/// Removes this run's scratch copies. The copies never contain links (they
/// are skipped while copying), and `remove_dir_all` does not follow them.
fn try_remove_scratch(id: &str) -> bool {
    if uuid::Uuid::parse_str(id).is_err() {
        return true;
    }
    let root = scratch_root(id);
    !root.exists() || std::fs::remove_dir_all(&root).is_ok() || !root.exists()
}

/// A just-killed attempt can hold its folder open for a moment on Windows,
/// so removal retries for up to five seconds.
pub(super) async fn remove_scratch(id: &str) {
    for _ in 0..50 {
        if try_remove_scratch(id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

struct ScratchGuard(String);
impl Drop for ScratchGuard {
    fn drop(&mut self) {
        if try_remove_scratch(&self.0) {
            return;
        }
        let id = self.0.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move { remove_scratch(&id).await });
        }
    }
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

/// Copies `src` into `dst`, skipping links/junctions and `SKIPPED_DIRS`.
fn copy_tree(src: &Path, dst: &Path, files: &mut usize, bytes: &mut u64) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|_| "best_of_copy_failed")?;
    let entries = std::fs::read_dir(src).map_err(|_| "best_of_copy_failed")?;
    for entry in entries {
        let entry = entry.map_err(|_| "best_of_copy_failed")?;
        let name = entry.file_name();
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|_| "best_of_copy_failed")?;
        if is_link(&metadata) {
            continue;
        }
        if metadata.is_dir() {
            if SKIPPED_DIRS.iter().any(|skip| name.to_string_lossy().eq_ignore_ascii_case(skip)) {
                continue;
            }
            copy_tree(&entry.path(), &dst.join(&name), files, bytes)?;
        } else if metadata.is_file() {
            *files += 1;
            *bytes += metadata.len();
            if *files > MAX_COPY_FILES || *bytes > MAX_COPY_BYTES {
                return Err("best_of_workspace_too_large".into());
            }
            std::fs::copy(entry.path(), dst.join(&name)).map_err(|_| "best_of_copy_failed")?;
        }
    }
    Ok(())
}

/// Lines removed plus lines added (line-level LCS after trimming the common
/// prefix and suffix; a very large middle falls back to its full size).
pub(super) fn changed_lines(before: &str, after: &str) -> u64 {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (a, b) = trim_common(&a, &b);
    if a.len().saturating_mul(b.len()) > 4_000_000 {
        return (a.len() + b.len()) as u64;
    }
    let mut row = vec![0usize; b.len() + 1];
    for left in a {
        let mut diagonal = 0;
        for (j, right) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if left == right { diagonal + 1 } else { above.max(row[j]) };
            diagonal = above;
        }
    }
    (a.len() + b.len() - 2 * row[b.len()]) as u64
}

fn trim_common<'a, 'b>(a: &'a [&'b str], b: &'a [&'b str]) -> (&'a [&'b str], &'a [&'b str]) {
    let start = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[start..], &b[start..]);
    let end = a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
    (&a[..a.len() - end], &b[..b.len() - end])
}

/// A compact review diff: the changed middle of each file after trimming the
/// common prefix and suffix.
fn review_diff(files: &[AttemptFile]) -> String {
    let mut text = String::new();
    for file in files {
        let a: Vec<&str> = file.before.lines().collect();
        let b: Vec<&str> = file.after.lines().collect();
        let start = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let (left, right) = trim_common(&a, &b);
        text.push_str(&format!("--- a/{0}\n+++ b/{0}\n@@ line {1} @@\n", file.path, start + 1));
        for line in left {
            text.push_str(&format!("-{line}\n"));
        }
        for line in right {
            text.push_str(&format!("+{line}\n"));
        }
    }
    if text.chars().count() > MAX_REVIEW_DIFF_CHARS {
        text = text.chars().take(MAX_REVIEW_DIFF_CHARS).collect();
        text.push_str("\n[diff truncated]\n");
    }
    text
}

#[derive(Clone, Debug)]
struct AttemptFile {
    path: String,
    before: String,
    before_sha256: Option<String>,
    after: String,
}

/// The final files an attempt changed through Hub's file tools, read from its
/// scratch copy (the content its verification saw). `None` when the attempt's
/// change record is incomplete or a changed file can no longer be read.
fn attempt_files(service: &PiWorkService, run_id: &str) -> Option<Vec<AttemptFile>> {
    let run = service.run(run_id)?;
    let archive = run.file_changes.lock().unwrap().clone();
    let summary = archive.summary();
    // A failed save of the encrypted record leaves the in-memory record whole;
    // any other incomplete reason means a write may be missing from it.
    if summary.status != "tracked" && summary.reason.as_deref() != Some("save_failed") {
        return None;
    }
    let mut files = Vec::new();
    for item in summary.items {
        let diff = archive.diff(&run.workspace, &item.id).ok()?;
        let after = crate::agent_tools::read_text(&run.workspace, &item.path, crate::agent_tools::MAX_FILE_BYTES).ok()?;
        files.push(AttemptFile {
            path: item.path,
            before: diff.before,
            before_sha256: item.before_sha256,
            after: after.content,
        });
    }
    Some(files)
}

/// Selection rule: a Hub-verified attempt with the fewest changed lines; the
/// lower index wins a tie. Exposed for tests.
pub(super) fn select(attempts: &[BestOfAttempt]) -> Option<usize> {
    attempts
        .iter()
        .enumerate()
        .filter(|(_, attempt)| attempt.verified && attempt.changed_lines.is_some())
        .min_by_key(|(index, attempt)| (attempt.changed_lines.unwrap_or(u64::MAX), *index))
        .map(|(index, _)| index)
}

struct Context {
    service: PiWorkService,
    leases: Arc<tokio::sync::Mutex<DevRuns>>,
    id: String,
    workspace: PathBuf,
    prompt: String,
    model: Option<String>,
    script: Option<String>,
    allow_exec: bool,
    allow_http: bool,
    verification: VerificationCommand,
    checkers: Vec<crate::verification::VerificationCommand>,
    estimate: BestOfEstimate,
    run: Arc<PiRun>,
    /// Engine of every attempt (thin since 2026-10-18); applying the winner uses Hub's tools.
    engine: WorkEngine,
}

impl Context {
    fn update(&self, change: impl FnOnce(&mut PiRunState)) {
        let mut state = self.run.state.lock().unwrap();
        if state.status != "running" {
            return;
        }
        change(&mut state);
        drop(state);
        self.run.changes.send_modify(|version| *version += 1);
    }

    fn update_best_of(&self, change: impl FnOnce(&mut BestOfState)) {
        self.update(|state| {
            if let Some(best_of) = state.best_of.as_mut() {
                change(best_of);
            }
        });
    }

    async fn finish(&self, phase: &str, status: &str, verified: bool, error: Option<&str>) {
        let snapshot = {
            let mut state = self.run.state.lock().unwrap();
            if state.status != "running" {
                return;
            }
            state.status = status.into();
            state.ended_at_ms = Some(now_ms());
            clear_transient(&mut state);
            if let Some(best_of) = state.best_of.as_mut() {
                best_of.phase = phase.into();
            }
            state.outcome = Some(PiOutcome {
                ok: status == "done",
                verified,
                exit_code: None,
                error: error.map(str::to_owned),
            });
            state.clone()
        };
        self.run.changes.send_modify(|version| *version += 1);
        self.service.record_terminal(&self.run.recorded, &snapshot);
        self.run.decisions.lock().unwrap().clear();
        self.leases.lock().await.release_work(&self.workspace, &self.id);
        queue_runtime::after_terminal(self.service.clone(), self.leases.clone(), &snapshot);
    }
}

/// Validates, leases the real workspace for the whole operation, registers the
/// parent run and starts the orchestrator. `script` is a test seam only: the
/// native and paired entry points always pass `None`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn launch(
    service: &PiWorkService,
    leases: &Arc<tokio::sync::Mutex<DevRuns>>,
    workspace: PathBuf,
    prompt: &str,
    model: Option<&str>,
    allow_exec: bool,
    allow_http: bool,
    verification: Option<VerificationCommand>,
    checkers: Vec<VerificationCommand>,
    request: BestOfRequest,
    engine: WorkEngine,
) -> Result<PiRunState, String> {
    launch_with_script(service, leases, workspace, prompt, model, None, allow_exec, allow_http,
        verification, checkers, request, engine).await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn launch_with_script(
    service: &PiWorkService,
    leases: &Arc<tokio::sync::Mutex<DevRuns>>,
    workspace: PathBuf,
    prompt: &str,
    model: Option<&str>,
    script: Option<&str>,
    allow_exec: bool,
    allow_http: bool,
    verification: Option<VerificationCommand>,
    checkers: Vec<VerificationCommand>,
    request: BestOfRequest,
    engine: WorkEngine,
) -> Result<PiRunState, String> {
    if engine != WorkEngine::Thin {
        return Err("best_of_unsupported".into());
    }
    let estimate = estimate(request.attempts, request.token_cap)?;
    if request.estimate_tokens != estimate.max_tokens {
        return Err("best_of_estimate_unconfirmed".into());
    }
    let verification = verification.ok_or("best_of_requires_verification")?;
    if !allow_exec {
        return Err("verification_requires_exec".into());
    }
    verification.validate()?;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt_empty".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("prompt_too_long".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    leases.lock().await.reserve_work(&workspace, &id).map_err(str::to_owned)?;
    let display_model = model.map(str::to_owned).unwrap_or_else(default_model);
    let state = Arc::new(Mutex::new(PiRunState {
        image_receipt_valid: true, image_attachments: Vec::new(), image_context_refs: Vec::new(),
        prompt_image_ids: Vec::new(), reattached_image_ids: Vec::new(), image_request_id: None,
        fast_check: None, compaction: None,
        best_of: Some(BestOfState {
            estimate: estimate.clone(),
            phase: "copying".into(),
            attempts: (0..estimate.attempts)
                .map(|index| BestOfAttempt { index, status: "pending".into(), ..BestOfAttempt::default() })
                .collect(),
            ..BestOfState::default()
        }),
        generation: None, supports_steering: false, instructions: Vec::new(), changes: PiChangeSummary::default(),
        verification: Some(Default::default()),
        engine,
        usage: PiUsage::default(),
        continuation: PiContinuation::default(),
        final_output: String::new(),
        id: id.clone(),
        workspace: non_verbatim(workspace.clone()).to_string_lossy().into_owned(),
        script: "best-of".into(),
        model: display_model,
        prompt: prompt.to_owned(),
        allow_write: false,
        allow_exec,
        allow_http,
        allow_test: false,
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
    let file_changes = Arc::new(Mutex::new(PiChangeArchive::new()));
    state.lock().unwrap().changes = file_changes.lock().unwrap().summary();
    let (changes, _) = watch::channel(0u64);
    let run = Arc::new(PiRun {
        steering: None, steering_checkpoint: None, steering_ledger: Mutex::default(),
        steering_gate: tokio::sync::Mutex::new(()), file_changes, state: state.clone(),
        workspace: workspace.clone(), stderr: Arc::new(Mutex::default()),
        decisions: Arc::new(Mutex::new(HashMap::new())), wait: Mutex::new(None),
        recorded: Arc::new(AtomicBool::new(false)), changes,
    });
    let context = Context {
        service: service.clone(), leases: leases.clone(), id: id.clone(), workspace,
        prompt: prompt.to_owned(), model: model.map(str::to_owned), script: script.map(str::to_owned),
        allow_exec, allow_http, verification, checkers, estimate, run: run.clone(), engine,
    };
    let mut wait = run.wait.lock().unwrap();
    {
        let mut inner = service.inner.lock().unwrap();
        inner.order.push(id.clone());
        inner.runs.insert(id.clone(), run.clone());
        inner.children.insert(id.clone(), Vec::new());
    }
    *wait = Some(tokio::spawn(orchestrate(context)));
    drop(wait);
    let snapshot = state.lock().unwrap().clone();
    Ok(snapshot)
}

async fn orchestrate(context: Context) {
    let _scratch = ScratchGuard(context.id.clone());
    let n = context.estimate.attempts as usize;
    let root = scratch_root(&context.id);
    let dirs: Vec<PathBuf> = (1..=n).map(|index| root.join(format!("attempt-{index}"))).collect();
    let source = context.workspace.clone();
    let targets = dirs.clone();
    let copied = tokio::task::spawn_blocking(move || -> Result<Vec<PathBuf>, String> {
        targets
            .iter()
            .map(|dir| {
                let (mut files, mut bytes) = (0, 0);
                copy_tree(&source, dir, &mut files, &mut bytes)?;
                resolve_workspace(&dir.to_string_lossy())
            })
            .collect()
    })
    .await
    .unwrap_or_else(|_| Err("best_of_copy_failed".into()));
    let dirs = match copied {
        Ok(dirs) => dirs,
        Err(error) => return context.finish("failed", "failed", false, Some(&error)).await,
    };
    context.update_best_of(|best_of| best_of.phase = "attempts".into());
    for (index, dir) in dirs.into_iter().enumerate() {
        let started = launch_inner(&context.service, &context.leases, dir, &context.prompt,
            context.model.as_deref(), context.script.as_deref(), true, context.allow_exec,
            context.allow_http, None, context.engine, Some(context.verification.clone()), None, None,
            context.checkers.clone()).await;
        match started {
            Ok(child) => {
                if let Some(children) = context.service.inner.lock().unwrap().children.get_mut(&context.id) {
                    children.push(child.id.clone());
                }
                context.update_best_of(|best_of| {
                    best_of.attempts[index].run_id = Some(child.id.clone());
                    best_of.attempts[index].status = "running".into();
                });
            }
            Err(error) => context.update_best_of(|best_of| {
                best_of.attempts[index].status = "failed".into();
                best_of.attempts[index].error = Some(error);
            }),
        }
    }
    // Watch every attempt to its end; one past the token cap is cancelled.
    let cap = context.estimate.token_cap_per_attempt;
    loop {
        let ids: Vec<(usize, String)> = context.run.state.lock().unwrap().best_of.as_ref()
            .map(|best_of| best_of.attempts.iter().enumerate()
                .filter_map(|(index, attempt)| attempt.run_id.clone().map(|id| (index, id))).collect())
            .unwrap_or_default();
        let mut running = false;
        for (index, id) in ids {
            // Read the record directly: `status` also probes steering, which spawns git.
            let Some(mut view) = context.service.run(&id).map(|run| run.state.lock().unwrap().clone()) else { continue };
            let tokens = view.usage.input + view.usage.output + view.usage.cache_read + view.usage.cache_write;
            let mut capped = false;
            if view.status == "running" && tokens > cap {
                if let Ok(cancelled) = context.service.cancel(&id, &context.leases).await {
                    view = cancelled;
                }
                capped = true;
            }
            running |= view.status == "running";
            context.update_best_of(|best_of| {
                let attempt = &mut best_of.attempts[index];
                attempt.status = view.status.clone();
                attempt.tokens = tokens;
                attempt.capped |= capped;
                attempt.verified = view.outcome.as_ref().is_some_and(|outcome| outcome.verified);
                if attempt.capped {
                    attempt.error = Some("best_of_token_cap".into());
                }
            });
        }
        if !running {
            break;
        }
        tokio::time::sleep(MONITOR_TICK).await;
    }
    // Measure each finished attempt from its own change record and scratch copy.
    let attempts = context.run.state.lock().unwrap().best_of.as_ref().map(|best_of| best_of.attempts.clone()).unwrap_or_default();
    let mut measured: Vec<Option<Vec<AttemptFile>>> = Vec::new();
    for attempt in &attempts {
        let files = attempt.run_id.as_deref().filter(|_| attempt.status != "cancelled")
            .and_then(|id| attempt_files(&context.service, id));
        measured.push(files);
    }
    context.update_best_of(|best_of| {
        for (attempt, files) in best_of.attempts.iter_mut().zip(&measured) {
            match files {
                Some(files) => {
                    attempt.changed_lines = Some(files.iter().map(|file| changed_lines(&file.before, &file.after)).sum());
                    attempt.files = files.iter().map(|file| file.path.clone()).collect();
                }
                None if attempt.verified => {
                    // A pass whose change record cannot be trusted is not applied.
                    attempt.verified = false;
                    attempt.error.get_or_insert_with(|| "best_of_changes_incomplete".into());
                }
                None => {}
            }
        }
    });
    let attempts = context.run.state.lock().unwrap().best_of.as_ref().map(|best_of| best_of.attempts.clone()).unwrap_or_default();
    let Some(selected) = select(&attempts) else {
        let best = attempts.iter().enumerate()
            .filter(|(index, attempt)| attempt.changed_lines.is_some_and(|lines| lines > 0) && measured[*index].is_some())
            .min_by_key(|(index, attempt)| (attempt.changed_lines, *index))
            .map(|(index, _)| index);
        let diff = best.and_then(|index| measured[index].as_deref()).map(review_diff).unwrap_or_default();
        context.update_best_of(|best_of| best_of.review_diff = diff);
        return context.finish("none_passed", "failed", false, Some("best_of_none_passed")).await;
    };
    let files = measured[selected].clone().unwrap_or_default();
    context.update_best_of(|best_of| {
        best_of.selected = Some(selected as u32);
        best_of.phase = "applying".into();
    });
    apply(&context, files).await;
}

/// Applies the selected attempt's files to the real workspace, once each,
/// through the ordinary approval-gated `hub_write` path, then runs the declared
/// verification once in the real workspace.
async fn apply(context: &Context, files: Vec<AttemptFile>) {
    let run = &context.run;
    let observer_state = run.state.clone();
    let observer_archive = run.file_changes.clone();
    let observer_store = context.service.checkpoints.clone();
    let observer_workspace = context.workspace.clone();
    let observer_changes = run.changes.clone();
    let run_files = crate::agent_tools::Files::with_change_observer(Arc::new(move |change| {
        let mut state = observer_state.lock().unwrap();
        let mut archive = observer_archive.lock().unwrap();
        archive.record(change);
        persist_changes(&observer_store, &observer_workspace, &mut state, &mut archive);
        observer_changes.send_modify(|version| *version += 1);
    }));
    let approver = crate::verification::declared_approver(
        approver_for(run.state.clone(), run.decisions.clone(), run.changes.clone()),
        context.verification.clone(),
    );
    let executor = hub_executor_sharing_files(
        context.workspace.clone(),
        false,
        HubToolCaps { exec: true, http: false, test: false, native_fs: false },
        Some(approver),
        Arc::new(Mutex::new(run_files)),
    );
    let report_state = run.state.clone();
    let report_changes = run.changes.clone();
    let executor = crate::verification::gate(executor, context.verification.clone(), Arc::new(move |report| {
        let mut state = report_state.lock().unwrap();
        if state.status != "running" {
            return;
        }
        state.verification = Some(report);
        report_changes.send_modify(|version| *version += 1);
    }));
    for file in files {
        // The real file must still be what the attempt started from.
        let current = crate::agent_tools::read_text(&context.workspace, &file.path, crate::agent_tools::MAX_FILE_BYTES);
        let unchanged = match (&file.before_sha256, &current) {
            (Some(hash), Ok(current)) => &crate::agent_tools::digest(current.content.as_bytes()) == hash,
            (None, Err(_)) => !context.workspace.join(&file.path).exists(),
            _ => false,
        };
        if !unchanged {
            return context.finish("conflict", "failed", false, Some("best_of_workspace_changed")).await;
        }
        if file.before_sha256.is_some() {
            if let Err(error) = executor.execute("hub_read".into(), json!({"path": file.path})).await {
                return context.finish("failed", "failed", false, Some(&error)).await;
            }
        }
        let summary = format!("best-of: apply attempt result to {}", file.path);
        match executor.execute("hub_write".into(), json!({"path": file.path, "content": file.after, "summary": summary})).await {
            Ok(_) => context.update_best_of(|best_of| best_of.applied_files.push(file.path.clone())),
            Err(error) if error == "approval_denied" => {
                return context.finish("denied", "failed", false, Some("approval_denied")).await;
            }
            Err(error) => {
                let phase = if error.starts_with("file_changed") { "conflict" } else { "failed" };
                return context.finish(phase, "failed", false, Some(&error)).await;
            }
        }
    }
    context.update_best_of(|best_of| best_of.phase = "verifying".into());
    let checked = executor.execute("hub_exec".into(), context.verification.value()).await;
    let passed = context.run.state.lock().unwrap().verification.as_ref().is_some_and(|check| check.status == "passed")
        && checked.is_ok();
    if passed {
        context.finish("applied", "done", true, None).await;
    } else {
        context.finish("applied", "failed", false, Some("required_verification_not_passed")).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tokio::sync::Mutex as AsyncMutex;

    fn temp_workspace() -> (crate::agent_tools::TestWorkspace, PathBuf) {
        let path = std::env::temp_dir().join(format!("hub-best-of-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let path = path.canonicalize().unwrap();
        (crate::agent_tools::TestWorkspace { path: path.clone() }, path)
    }

    /// A scripted sidecar: writes `answer.txt` with the content the prompt maps
    /// to its scratch folder name, runs the declared verification, reports
    /// `usage` tokens, then finishes — or hangs when told to.
    const STUB: &str = r#"
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
const plan = JSON.parse(process.argv[3])[basename(process.cwd())] ?? {};
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const lines = createInterface({ input: process.stdin });
let pending = null;
lines.on('line', line => { const frame = JSON.parse(line); if (frame.type === 'session') start(); else if (pending && frame.id === pending.id) { const done = pending.done; pending = null; done(frame); } });
const call = (name, args) => new Promise(done => { pending = { id: 'c' + Math.random(), done }; send({ type: 'tool_call', id: pending.id, name, args }); });
async function start() {
  send({ type: 'hello', proto: 1, activeTools: ['hub_write', 'hub_exec'] });
  if (plan.tokens) send({ type: 'event', event: { type: 'message_end', message: { role: 'assistant', usage: { input: plan.tokens, output: 0, cacheRead: 0, cacheWrite: 0 } } } });
  if (plan.hang) return;
  await call('hub_read', { path: 'answer.txt' });
  await call('hub_write', { path: 'answer.txt', content: plan.content });
  await call('hub_exec', { program: 'node', args: ['verify.cjs'] });
  send({ type: 'agent_done', ok: true });
  lines.close();
}
"#;

    struct Fixture {
        _guard: crate::agent_tools::TestWorkspace,
        root: PathBuf,
        script: String,
        service: PiWorkService,
        leases: Arc<AsyncMutex<DevRuns>>,
    }

    fn fixture() -> Fixture {
        let (guard, root) = temp_workspace();
        std::fs::write(root.join("answer.txt"), "start\n").unwrap();
        std::fs::write(root.join("verify.cjs"),
            "process.exit(require('fs').readFileSync('answer.txt','utf8').startsWith('good')?0:1)").unwrap();
        let script = root.join("stub.mjs");
        std::fs::write(&script, STUB).unwrap();
        let script = non_verbatim(script).to_string_lossy().into_owned();
        Fixture { _guard: guard, root, script, service: PiWorkService::default(), leases: Arc::new(AsyncMutex::new(DevRuns::default())) }
    }

    fn verification() -> VerificationCommand {
        serde_json::from_value(json!({"program":"node","args":["verify.cjs"]})).unwrap()
    }

    async fn start(f: &Fixture, plan: Value, cap: Option<u64>) -> Result<PiRunState, String> {
        let attempts = plan.as_object().unwrap().len() as u32;
        let estimate = estimate(attempts, cap).unwrap();
        launch_with_script(&f.service, &f.leases, f.root.clone(), &plan.to_string(), Some("stub/stub-1"),
            Some(&f.script), true, false, Some(verification()), Vec::new(),
            BestOfRequest { attempts, token_cap: cap, estimate_tokens: estimate.max_tokens }, WorkEngine::Thin).await
    }

    async fn until(f: &Fixture, id: &str, done: impl Fn(&PiRunState) -> bool) -> PiRunState {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let view = f.service.status(id).unwrap();
            if done(&view) {
                return view;
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out: {:?}", view.best_of);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn scratch_removed(id: &str) {
        for _ in 0..100 {
            if !scratch_root(id).exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("scratch copies left behind");
    }

    #[test]
    fn estimate_bounds_and_selection_rule() {
        assert_eq!(estimate(3, None).unwrap().max_tokens, 3 * DEFAULT_TOKEN_CAP);
        for (attempts, cap) in [(1, None), (4, None), (2, Some(10)), (2, Some(MAX_TOKEN_CAP + 1))] {
            assert!(estimate(attempts, cap).is_err());
        }
        let attempt = |verified, lines| BestOfAttempt { verified, changed_lines: Some(lines), ..BestOfAttempt::default() };
        assert_eq!(select(&[attempt(false, 1), attempt(true, 9), attempt(true, 3)]), Some(2));
        assert_eq!(select(&[attempt(true, 3), attempt(true, 3)]), Some(0), "ties go to the first attempt");
        assert_eq!(select(&[attempt(false, 1), attempt(false, 2)]), None);
        assert_eq!(changed_lines("a\nb\nc\n", "a\nx\nc\n"), 2);
        assert_eq!(changed_lines("a\n", "a\nb\nc\n"), 2);
        assert_eq!(changed_lines("same", "same"), 0);
    }

    #[tokio::test]
    async fn starts_only_with_a_shown_estimate_and_a_declared_verification() {
        let f = fixture();
        let plan = json!({"attempt-1":{}, "attempt-2":{}});
        let request = |estimate_tokens| BestOfRequest { attempts: 2, token_cap: None, estimate_tokens };
        let error = launch_with_script(&f.service, &f.leases, f.root.clone(), &plan.to_string(), None, Some(&f.script),
            true, false, Some(verification()), Vec::new(), request(DEFAULT_TOKEN_CAP), WorkEngine::Thin).await.unwrap_err();
        assert_eq!(error, "best_of_estimate_unconfirmed");
        let error = launch_with_script(&f.service, &f.leases, f.root.clone(), &plan.to_string(), None, Some(&f.script),
            true, false, None, Vec::new(), request(2 * DEFAULT_TOKEN_CAP), WorkEngine::Thin).await.unwrap_err();
        assert_eq!(error, "best_of_requires_verification");
        let error = launch_with_script(&f.service, &f.leases, f.root.clone(), &plan.to_string(), None, Some(&f.script),
            false, false, Some(verification()), Vec::new(), request(2 * DEFAULT_TOKEN_CAP), WorkEngine::Thin).await.unwrap_err();
        assert_eq!(error, "verification_requires_exec");
        assert!(f.service.list().is_empty(), "nothing started");
    }

    #[tokio::test]
    async fn the_smallest_passing_attempt_is_applied_once_through_an_approved_write() {
        let f = fixture();
        let plan = json!({
            "attempt-1": {"content": "bad\n"},
            "attempt-2": {"content": "good\nwith\nextra\nlines\n"},
            "attempt-3": {"content": "good\n"},
        });
        let parent = start(&f, plan, None).await.unwrap();
        let view = until(&f, &parent.id, |view| !view.pending_actions.is_empty()).await;
        // Nothing reached the real workspace while attempts ran.
        assert_eq!(std::fs::read_to_string(f.root.join("answer.txt")).unwrap(), "start\n");
        let best_of = view.best_of.clone().unwrap();
        assert_eq!(best_of.selected, Some(2), "{best_of:?}");
        assert_eq!(best_of.phase, "applying");
        assert!(!best_of.attempts[0].verified && best_of.attempts[1].verified && best_of.attempts[2].verified);
        assert_eq!(best_of.attempts[2].changed_lines, Some(2));
        assert_eq!(view.pending_actions.len(), 1);
        let action = view.pending_actions[0].clone();
        assert_eq!(action.tool, "hub_write");
        assert_eq!(action.detail["path"], "answer.txt");
        assert_eq!(action.detail["before"], "start\n");
        assert_eq!(action.detail["after"], "good\n");
        f.service.decide(&parent.id, &action.id, true, None).unwrap();
        assert_eq!(f.service.decide(&parent.id, &action.id, true, None).unwrap_err(), "pi_action_not_found");
        let done = until(&f, &parent.id, |view| view.status != "running").await;
        assert_eq!(done.status, "done", "{:?}", done.outcome);
        let outcome = done.outcome.unwrap();
        assert!(outcome.verified, "the real workspace passed Hub's own run of the declared command");
        assert_eq!(std::fs::read_to_string(f.root.join("answer.txt")).unwrap(), "good\n");
        let best_of = done.best_of.unwrap();
        assert_eq!(best_of.applied_files, ["answer.txt"]);
        assert_eq!(best_of.phase, "applied");
        assert_eq!(done.changes.items.len(), 1, "one change on the real workspace");
        scratch_removed(&parent.id).await;
        // Attempts ran in scratch copies, never in the real workspace.
        for attempt in &best_of.attempts {
            let child = f.service.status(attempt.run_id.as_deref().unwrap()).unwrap();
            assert_ne!(PathBuf::from(&child.workspace), non_verbatim(f.root.clone()));
        }
    }

    #[tokio::test]
    async fn a_denied_apply_writes_nothing_and_is_not_verified() {
        let f = fixture();
        let parent = start(&f, json!({"attempt-1": {"content": "good\n"}, "attempt-2": {"content": "bad\n"}}), None).await.unwrap();
        let view = until(&f, &parent.id, |view| !view.pending_actions.is_empty()).await;
        f.service.decide(&parent.id, &view.pending_actions[0].id, false, None).unwrap();
        let done = until(&f, &parent.id, |view| view.status != "running").await;
        assert_eq!(done.status, "failed");
        assert!(!done.outcome.unwrap().verified);
        assert_eq!(done.best_of.unwrap().phase, "denied");
        assert_eq!(std::fs::read_to_string(f.root.join("answer.txt")).unwrap(), "start\n");
    }

    #[tokio::test]
    async fn when_none_pass_nothing_is_applied_and_the_best_diff_is_kept_for_review() {
        let f = fixture();
        let parent = start(&f, json!({"attempt-1": {"content": "bad\nbad\nbad\n"}, "attempt-2": {"content": "bad\n"}}), None).await.unwrap();
        let done = until(&f, &parent.id, |view| view.status != "running").await;
        assert_eq!(done.status, "failed");
        let outcome = done.outcome.unwrap();
        assert!(!outcome.verified);
        assert_eq!(outcome.error.as_deref(), Some("best_of_none_passed"));
        assert!(done.pending_actions.is_empty());
        let best_of = done.best_of.unwrap();
        assert_eq!(best_of.phase, "none_passed");
        assert!(best_of.selected.is_none() && best_of.applied_files.is_empty());
        assert!(best_of.review_diff.contains("--- a/answer.txt"));
        assert!(best_of.review_diff.contains("-start\n+bad\n") && !best_of.review_diff.contains("+bad\n+bad"), "{}", best_of.review_diff);
        assert_eq!(std::fs::read_to_string(f.root.join("answer.txt")).unwrap(), "start\n");
        assert!(done.changes.items.is_empty());
        assert!(history_metadata(&f.service.status(&parent.id).unwrap()).best_of.unwrap().review_diff.is_empty(),
            "the review diff never reaches plain history");
    }

    #[tokio::test]
    async fn a_hanging_attempt_is_cancelled_by_the_cap() {
        let f = fixture();
        let parent = start(&f, json!({"attempt-1": {"hang": true, "tokens": 5_000}, "attempt-2": {"content": "good\n"}}), Some(1_000)).await.unwrap();
        let view = until(&f, &parent.id, |view| !view.pending_actions.is_empty() || view.status != "running").await;
        let best_of = view.best_of.unwrap();
        assert!(best_of.attempts[0].capped && best_of.attempts[0].status == "cancelled", "{best_of:?}");
        assert_eq!(best_of.selected, Some(1));
        f.service.cancel(&parent.id, &f.leases).await.unwrap();
    }

    #[tokio::test]
    async fn cancelling_the_parent_cancels_every_attempt_and_applies_nothing() {
        let f = fixture();
        let parent = start(&f, json!({"attempt-1": {"hang": true}, "attempt-2": {"hang": true}, "attempt-3": {"hang": true}}), None).await.unwrap();
        let view = until(&f, &parent.id, |view| view.best_of.as_ref().unwrap().attempts.iter().all(|attempt| attempt.status == "running")).await;
        let children: Vec<String> = view.best_of.unwrap().attempts.iter().map(|attempt| attempt.run_id.clone().unwrap()).collect();
        let cancelled = f.service.cancel(&parent.id, &f.leases).await.unwrap();
        assert_eq!(cancelled.status, "cancelled");
        for child in children {
            assert_eq!(f.service.status(&child).unwrap().status, "cancelled");
        }
        assert!(!scratch_root(&parent.id).exists(), "cancel waits for the copies to go");
        assert_eq!(std::fs::read_to_string(f.root.join("answer.txt")).unwrap(), "start\n");
        // The real workspace lease is free again.
        f.leases.lock().await.reserve_work(&f.root, "next").unwrap();
    }

    #[test]
    fn copies_skip_links_vcs_and_build_caches() {
        let (_guard, root) = temp_workspace();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "a").unwrap();
        std::fs::write(root.join(".git/HEAD"), "x").unwrap();
        std::fs::write(root.join("target/debug/big"), "x").unwrap();
        let (_out_guard, out) = temp_workspace();
        let (mut files, mut bytes) = (0, 0);
        copy_tree(&root, &out.join("copy"), &mut files, &mut bytes).unwrap();
        assert_eq!(std::fs::read_to_string(out.join("copy/src/a.txt")).unwrap(), "a");
        assert!(!out.join("copy/.git").exists() && !out.join("copy/target").exists());
        assert_eq!(files, 1);
    }
}
