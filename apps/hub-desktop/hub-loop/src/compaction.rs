//! Context compaction policy (owner decision 2026-11-06).
//!
//! When the estimated prompt grows past a share of the model's context window,
//! the OLDEST turns are replaced by one summary turn written by an injected
//! [`Summariser`] (the same model-call interface the loop uses). Never touched:
//!
//! - system turns;
//! - the latest `keep_recent` turns;
//! - a tool call and its result are never split, and a tool call that has no
//!   result yet, or that is waiting on an approval, stays in full together
//!   with everything after it.
//!
//! The `compacted` record is committed to the journal BEFORE the compacted
//! context is returned, so a resume rebuilds exactly the same context with
//! [`apply_compactions`]. If the summariser or the journal fails, the full
//! context is kept (the caller's turns are never modified; this module only
//! returns a new list on success) and the next attempt waits until the context
//! has grown, so a failing summariser is not called on every turn.
//!
//! Token counts are estimates (see [`estimate_tokens`]), not measurements.

use crate::journal::{sanitize, Compaction, Journal};
use serde_json::Value;
use std::{collections::HashSet, sync::Mutex};

/// Used when the model's window is unknown. Deliberately small.
pub const DEFAULT_CONTEXT_WINDOW: usize = 32_000;
/// Summary text is cut to this many bytes so the journal copy equals the used copy.
pub const MAX_SUMMARY_BYTES: usize = 3_500;

/// What the summariser is asked to keep. The text is for the model.
pub const SUMMARY_INSTRUCTION: &str = "Summarise the earlier part of this working session so it can replace those turns. \
Keep, exactly and in full: every file path, every command that was run and its outcome, every decision and the reason for it, \
every error message that is still relevant, and every open TODO or unanswered question. \
Say what was tried and failed so it is not tried again. Do not invent facts, do not add advice, \
and do not repeat large file contents or command output; refer to them by path or command instead.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
    ToolCall,
    ToolResult,
    /// Produced by compaction.
    Summary,
}

/// One conversation turn. `id` is assigned by the caller, strictly increasing
/// over the whole session, and never reused.
#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub id: u64,
    pub role: Role,
    pub text: String,
    /// Set on `ToolCall` and `ToolResult`.
    pub call_id: Option<String>,
}

impl Turn {
    pub fn new(id: u64, role: Role, text: impl Into<String>) -> Self {
        Self { id, role, text: text.into(), call_id: None }
    }
    pub fn tool(id: u64, role: Role, call_id: &str, text: impl Into<String>) -> Self {
        Self { id, role, text: text.into(), call_id: Some(call_id.to_owned()) }
    }
}

/// Estimate only: ASCII about 4 bytes per token, other characters about one
/// token each, plus a few tokens of framing per turn. Errs high on purpose.
pub fn estimate_tokens(text: &str) -> usize {
    let (mut ascii, mut other) = (0usize, 0usize);
    for c in text.chars() {
        if c.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    ascii.div_ceil(4) + other
}

fn turn_tokens(t: &Turn) -> usize {
    estimate_tokens(&t.text) + 4
}

fn total_tokens(turns: &[Turn]) -> usize {
    turns.iter().map(turn_tokens).sum()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactionPolicy {
    pub context_window: usize,
    /// Compact when the estimate exceeds this share of the window.
    pub threshold_percent: usize,
    /// The latest turns that are always kept as they are.
    pub keep_recent: usize,
}

impl CompactionPolicy {
    /// `window` comes from model metadata when known; otherwise a conservative default.
    pub fn for_window(window: Option<u64>) -> Self {
        let context_window = window.filter(|w| *w >= 512).map_or(DEFAULT_CONTEXT_WINDOW, |w| w as usize);
        Self { context_window, threshold_percent: 70, keep_recent: 6 }
    }
    pub fn threshold_tokens(&self) -> usize {
        self.context_window / 100 * self.threshold_percent + self.context_window % 100 * self.threshold_percent / 100
    }
}

impl Default for CompactionPolicy {
    fn default() -> Self {
        Self::for_window(None)
    }
}

/// What the summariser receives.
#[derive(Clone, Debug)]
pub struct SummaryRequest {
    pub instruction: &'static str,
    /// The turns to be replaced. May start with an earlier summary.
    pub turns: Vec<Turn>,
    /// A suggested ceiling for the answer, in tokens.
    pub max_tokens: usize,
}

/// The model call, injected. Provider-neutral.
pub trait Summariser {
    fn summarise(&self, request: &SummaryRequest) -> Result<String, String>;
}

/// Turns that the next model turn still depends on, beyond what the turn list
/// shows by itself (a call with no result is detected automatically).
#[derive(Clone, Debug, Default)]
pub struct Pending {
    /// Call ids waiting on an approval or otherwise still in flight.
    pub call_ids: HashSet<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoOpReason {
    BelowThreshold,
    /// Nothing old enough, or everything old is protected.
    NothingToCompact,
    /// A recent failure; waiting for the context to grow.
    Backoff,
    /// The summary would not make the context smaller.
    NoGain,
}

#[derive(Debug)]
pub enum Outcome {
    NoOp(NoOpReason),
    Compacted { turns: Vec<Turn>, record: Compaction },
    /// The caller keeps its full context. `retry_above_tokens` is when to try again.
    Failed { error: String, retry_above_tokens: usize },
}

#[derive(Debug, PartialEq, Eq)]
pub enum CompactionError {
    /// A record names turns that are not (or not contiguously) in the list.
    Mismatch { covered_from: u64, covered_to: u64 },
}

impl std::fmt::Display for CompactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mismatch { covered_from, covered_to } => {
                write!(f, "compaction_mismatch:{covered_from}-{covered_to}")
            }
        }
    }
}
impl std::error::Error for CompactionError {}

fn summary_turn(from: u64, to: u64, count: u64, summary: &str) -> Turn {
    Turn::new(to, Role::Summary, format!("[Summary of {count} earlier turns, #{from}-#{to}]\n{summary}"))
}

fn clamp_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Rebuilds the compacted context from the full original turns and the
/// journal's compactions, in order. Deterministic: the same inputs give the
/// same turns the live run used.
pub fn apply_compactions(original: &[Turn], compactions: &[Compaction]) -> Result<Vec<Turn>, CompactionError> {
    let mut turns = original.to_vec();
    for c in compactions {
        let mismatch = CompactionError::Mismatch { covered_from: c.covered_from, covered_to: c.covered_to };
        let idx: Vec<usize> = turns
            .iter()
            .enumerate()
            .filter(|(_, t)| t.id >= c.covered_from && t.id <= c.covered_to)
            .map(|(i, _)| i)
            .collect();
        let contiguous = idx.windows(2).all(|w| w[1] == w[0] + 1);
        let ends_ok = idx.first().is_some_and(|i| turns[*i].id == c.covered_from)
            && idx.last().is_some_and(|i| turns[*i].id == c.covered_to);
        if idx.is_empty() || !contiguous || !ends_ok || idx.len() as u64 != c.covered_turns {
            return Err(mismatch);
        }
        let summary = summary_turn(c.covered_from, c.covered_to, c.covered_turns, &c.summary);
        turns.splice(idx[0]..=idx[idx.len() - 1], [summary]);
    }
    Ok(turns)
}

pub struct Compactor<S: Summariser> {
    pub policy: CompactionPolicy,
    summariser: S,
    /// After a failure: do not try again until the estimate exceeds this.
    retry_above: Mutex<Option<usize>>,
}

impl<S: Summariser> Compactor<S> {
    pub fn new(policy: CompactionPolicy, summariser: S) -> Self {
        Self { policy, summariser, retry_above: Mutex::new(None) }
    }

    /// The half-open range `start..cut` that may be replaced, if any.
    fn plan(&self, turns: &[Turn], pending: &Pending) -> Option<(usize, usize)> {
        let start = turns.iter().position(|t| t.role != Role::System)?;
        if turns.len() <= start + self.policy.keep_recent {
            return None;
        }
        let mut cut = turns.len() - self.policy.keep_recent;
        let resolved: HashSet<&str> = turns
            .iter()
            .filter(|t| t.role == Role::ToolResult)
            .filter_map(|t| t.call_id.as_deref())
            .collect();
        for (i, t) in turns.iter().enumerate().skip(start) {
            let waiting = t.call_id.as_deref().is_some_and(|id| pending.call_ids.contains(id));
            let unanswered = t.role == Role::ToolCall && t.call_id.as_deref().is_some_and(|id| !resolved.contains(id));
            if t.role == Role::System || waiting || unanswered {
                cut = cut.min(i);
            }
        }
        // Never split a call from its result.
        loop {
            let before = cut;
            for (i, t) in turns.iter().enumerate() {
                let Some(id) = t.call_id.as_deref() else { continue };
                if t.role == Role::ToolCall {
                    let result_at = turns.iter().position(|r| r.role == Role::ToolResult && r.call_id.as_deref() == Some(id));
                    if i < cut && result_at.is_some_and(|j| j >= cut) {
                        cut = i;
                    }
                } else if t.role == Role::ToolResult && i >= cut {
                    let call_at = turns.iter().position(|c| c.role == Role::ToolCall && c.call_id.as_deref() == Some(id));
                    if let Some(k) = call_at.filter(|k| *k < cut) {
                        cut = k;
                    }
                }
            }
            if cut == before {
                break;
            }
        }
        (cut >= start + 2).then_some((start, cut))
    }

    /// Compacts `turns` if the policy says so. `turns` is never modified; on
    /// `Compacted` the new list is returned and the record is already in the
    /// journal.
    pub fn compact(&self, turns: &[Turn], pending: &Pending, journal: Option<&Journal>) -> Outcome {
        let before = total_tokens(turns);
        if before <= self.policy.threshold_tokens() {
            return Outcome::NoOp(NoOpReason::BelowThreshold);
        }
        if self.retry_above.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|gate| before <= gate) {
            return Outcome::NoOp(NoOpReason::Backoff);
        }
        let Some((start, cut)) = self.plan(turns, pending) else {
            return Outcome::NoOp(NoOpReason::NothingToCompact);
        };
        let region = &turns[start..cut];
        let fail = |error: String| {
            let step = (self.policy.context_window / 20).max(256);
            let gate = before + step;
            *self.retry_above.lock().unwrap_or_else(|e| e.into_inner()) = Some(gate);
            Outcome::Failed { error, retry_above_tokens: gate }
        };
        let request = SummaryRequest {
            instruction: SUMMARY_INSTRUCTION,
            turns: region.to_vec(),
            max_tokens: (self.policy.context_window / 10).clamp(256, 2_000),
        };
        let raw = match self.summariser.summarise(&request) {
            Ok(text) if !text.trim().is_empty() => text,
            Ok(_) => return fail("summary_empty".into()),
            Err(e) => return fail(format!("summariser:{e}")),
        };
        // What is journaled must equal what is used, so redact and clamp first.
        let clean = match sanitize(&Value::String(clamp_bytes(raw.trim(), MAX_SUMMARY_BYTES).to_owned())) {
            Value::String(s) => s,
            _ => return fail("summary_invalid".into()),
        };
        if sanitize(&Value::String(clean.clone())) != Value::String(clean.clone()) {
            return fail("summary_not_journalable".into());
        }
        let (from, to) = (region[0].id, region[region.len() - 1].id);
        let summary = summary_turn(from, to, region.len() as u64, &clean);
        let mut out = Vec::with_capacity(turns.len() - region.len() + 1);
        out.extend_from_slice(&turns[..start]);
        out.push(summary);
        out.extend_from_slice(&turns[cut..]);
        let after = total_tokens(&out);
        if after >= before {
            return Outcome::NoOp(NoOpReason::NoGain);
        }
        let record = Compaction {
            covered_from: from,
            covered_to: to,
            covered_turns: region.len() as u64,
            summary: clean,
            tokens_before: before as u64,
            tokens_after: after as u64,
            reason: "threshold".into(),
            first_kept: None,
        };
        // Committed before the compacted context is used.
        if let Some(journal) = journal {
            if let Err(e) = journal.compacted(&record) {
                return fail(format!("{e}"));
            }
        }
        *self.retry_above.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Outcome::Compacted { turns: out, record }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::Journal;
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Fixed(&'static str);
    impl Summariser for Fixed {
        fn summarise(&self, _: &SummaryRequest) -> Result<String, String> {
            Ok(self.0.to_owned())
        }
    }
    struct Failing(Cell<u32>);
    impl Summariser for Failing {
        fn summarise(&self, _: &SummaryRequest) -> Result<String, String> {
            self.0.set(self.0.get() + 1);
            Err("model_unavailable".into())
        }
    }

    fn temp() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("hub-loop-compact-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn policy(window: usize, keep: usize) -> CompactionPolicy {
        CompactionPolicy { context_window: window, threshold_percent: 70, keep_recent: keep }
    }

    /// System prompt, then `n` user/assistant/tool-call/tool-result rounds of
    /// about 400 characters each.
    fn session(rounds: u64) -> Vec<Turn> {
        let mut turns = vec![Turn::new(0, Role::System, "You are Hub's coding agent. Obey the user.")];
        let mut id = 1;
        for r in 0..rounds {
            let filler = format!("{} ", "lorem ipsum dolor sit amet").repeat(16);
            turns.push(Turn::new(id, Role::User, format!("round {r}: edit src/mod{r}.rs. {filler}")));
            turns.push(Turn::new(id + 1, Role::Assistant, format!("I will run cargo test --lib mod{r}. {filler}")));
            turns.push(Turn::tool(id + 2, Role::ToolCall, &format!("c{r}"), format!("hub_exec cargo test --lib mod{r}")));
            turns.push(Turn::tool(id + 3, Role::ToolResult, &format!("c{r}"), format!("error[E0425] in src/mod{r}.rs: {filler}")));
            id += 4;
        }
        turns
    }

    #[test]
    fn below_threshold_is_a_no_op() {
        let turns = session(2);
        let c = Compactor::new(policy(32_000, 6), Fixed("s"));
        assert!(matches!(c.compact(&turns, &Pending::default(), None), Outcome::NoOp(NoOpReason::BelowThreshold)));
    }

    #[test]
    fn default_window_and_threshold_are_conservative() {
        let p = CompactionPolicy::for_window(None);
        assert_eq!((p.context_window, p.threshold_tokens()), (32_000, 22_400));
        assert_eq!(CompactionPolicy::for_window(Some(200_000)).threshold_tokens(), 140_000);
        assert_eq!(CompactionPolicy::for_window(Some(10)).context_window, 32_000);
    }

    #[test]
    fn keeps_system_latest_turns_and_replaces_the_old_ones_with_one_summary() {
        let turns = session(30);
        let c = Compactor::new(policy(4_000, 6), Fixed("Edited src/mod0.rs; cargo test --lib failed E0425; TODO: fix mod1."));
        let Outcome::Compacted { turns: out, record } = c.compact(&turns, &Pending::default(), None) else { panic!("expected compaction") };
        assert_eq!(out[0], turns[0], "system prompt untouched");
        assert_eq!(out[1].role, Role::Summary);
        assert_eq!(out.iter().filter(|t| t.role == Role::Summary).count(), 1);
        assert_eq!(out[out.len() - 6..], turns[turns.len() - 6..], "latest turns untouched");
        assert!(out[1].text.contains("src/mod0.rs") && out[1].text.contains("TODO"));
        assert!(record.tokens_after < record.tokens_before);
        assert_eq!(record.covered_from, 1);
    }

    #[test]
    fn a_call_is_never_split_from_its_result() {
        let turns = session(30);
        // keep_recent = 5 would cut between the last round's call and result.
        let c = Compactor::new(policy(4_000, 1), Fixed("s"));
        let Outcome::Compacted { turns: out, .. } = c.compact(&turns, &Pending::default(), None) else { panic!() };
        for t in out.iter().filter(|t| t.role == Role::ToolResult) {
            assert!(out.iter().any(|c| c.role == Role::ToolCall && c.call_id == t.call_id), "result kept without its call");
        }
        for t in out.iter().filter(|t| t.role == Role::ToolCall) {
            assert!(out.iter().any(|r| r.role == Role::ToolResult && r.call_id == t.call_id), "call kept without its result");
        }
    }

    #[test]
    fn an_unanswered_call_and_a_pending_approval_keep_everything_after_them() {
        let mut turns = session(30);
        // Call c5 never got a result and waits on an approval; c9 has a result but its approval is pending.
        let pos = turns.iter().position(|t| t.call_id.as_deref() == Some("c5") && t.role == Role::ToolResult).unwrap();
        turns.remove(pos);
        let mut pending = Pending::default();
        pending.call_ids.insert("c9".into());
        let c = Compactor::new(policy(4_000, 6), Fixed("s"));
        let Outcome::Compacted { turns: out, .. } = c.compact(&turns, &pending, None) else { panic!() };
        let first_kept = out.iter().position(|t| t.role != Role::System && t.role != Role::Summary).unwrap();
        assert_eq!(out[first_kept].id, turns.iter().find(|t| t.call_id.as_deref() == Some("c5")).unwrap().id,
            "everything from the first unanswered call on is kept");
        assert!(out.iter().any(|t| t.call_id.as_deref() == Some("c5")));
        assert!(out.iter().any(|t| t.call_id.as_deref() == Some("c9")));
    }

    #[test]
    fn a_middle_system_turn_is_never_compacted() {
        let mut turns = session(30);
        turns.insert(20, Turn::new(1000, Role::System, "Policy update: no network."));
        let c = Compactor::new(policy(4_000, 6), Fixed("s"));
        match c.compact(&turns, &Pending::default(), None) {
            Outcome::Compacted { turns: out, .. } => assert!(out.iter().any(|t| t.id == 1000)),
            Outcome::NoOp(_) => {}
            Outcome::Failed { .. } => panic!(),
        }
    }

    #[test]
    fn journal_replay_after_compaction_gives_the_identical_context() {
        let dir = temp();
        let journal = Journal::open(dir.join("s.jsonl"), 1 << 20).unwrap();
        let original = session(30);
        let c = Compactor::new(policy(4_000, 6), Fixed("Paths: src/mod0.rs. Command: cargo test --lib. Decision: keep API. Error E0425. TODO: mod3."));
        let Outcome::Compacted { turns: first, .. } = c.compact(&original, &Pending::default(), Some(&journal)) else { panic!() };
        // The session goes on, then a second compaction folds the first summary in.
        let mut live = first;
        let mut id = original.last().unwrap().id + 1;
        for r in 0..25u64 {
            let filler = "dolor sit amet ".repeat(30);
            live.push(Turn::new(id, Role::User, format!("more {r} {filler}")));
            live.push(Turn::new(id + 1, Role::Assistant, format!("ok {r} {filler}")));
            id += 2;
        }
        let Outcome::Compacted { turns: second, .. } = c.compact(&live, &Pending::default(), Some(&journal)) else { panic!("second") };
        // Resume: the host reloads the full history; the journal supplies the compactions.
        let mut full = original.clone();
        let mut id = original.last().unwrap().id + 1;
        for r in 0..25u64 {
            let filler = "dolor sit amet ".repeat(30);
            full.push(Turn::new(id, Role::User, format!("more {r} {filler}")));
            full.push(Turn::new(id + 1, Role::Assistant, format!("ok {r} {filler}")));
            id += 2;
        }
        let state = journal.replay().unwrap();
        assert_eq!(state.compactions.len(), 2);
        assert_eq!(apply_compactions(&full, &state.compactions).unwrap(), second);
        // A record that does not fit the history is an error, not a silent skip.
        assert!(apply_compactions(&original[..5], &state.compactions).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_record_is_in_the_journal_before_the_context_is_returned() {
        let dir = temp();
        let journal = Journal::open(dir.join("s.jsonl"), 1 << 20).unwrap();
        let c = Compactor::new(policy(4_000, 6), Fixed("s"));
        let Outcome::Compacted { record, .. } = c.compact(&session(30), &Pending::default(), Some(&journal)) else { panic!() };
        assert_eq!(journal.replay().unwrap().compactions, vec![record]);
        // A journal that cannot take the record means no compaction at all.
        let full = Journal::open(dir.join("t.jsonl"), 10).unwrap();
        let out = c.compact(&session(30), &Pending::default(), Some(&full));
        assert!(matches!(out, Outcome::Failed { .. }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn summariser_failure_keeps_the_context_and_retries_only_after_growth() {
        let turns = session(30);
        let c = Compactor::new(policy(4_000, 6), Failing(Cell::new(0)));
        let Outcome::Failed { retry_above_tokens, .. } = c.compact(&turns, &Pending::default(), None) else { panic!() };
        assert!(retry_above_tokens > total_tokens(&turns));
        // Same size: no second model call.
        assert!(matches!(c.compact(&turns, &Pending::default(), None), Outcome::NoOp(NoOpReason::Backoff)));
        assert_eq!(c.summariser.0.get(), 1);
        // Grown past the gate: tries again (and fails again, still without dropping anything).
        let mut grown = turns.clone();
        let mut id = turns.last().unwrap().id + 1;
        while total_tokens(&grown) <= retry_above_tokens {
            grown.push(Turn::new(id, Role::User, "x".repeat(400)));
            id += 1;
        }
        assert!(matches!(c.compact(&grown, &Pending::default(), None), Outcome::Failed { .. }));
        assert_eq!(c.summariser.0.get(), 2);
        assert_eq!(turns, session(30), "input untouched");
    }

    #[test]
    fn an_empty_or_secret_summary_is_handled_without_losing_turns() {
        let turns = session(30);
        assert!(matches!(Compactor::new(policy(4_000, 6), Fixed("  ")).compact(&turns, &Pending::default(), None), Outcome::Failed { .. }));
        let c = Compactor::new(policy(4_000, 6), Fixed("Ran with token=abc123 and Bearer abcdefghijklmnop"));
        let Outcome::Compacted { turns: out, record } = c.compact(&turns, &Pending::default(), None) else { panic!() };
        assert!(!record.summary.contains("abc123") && !out[1].text.contains("abcdefghijklmnop"));
    }

    #[test]
    fn a_summary_that_does_not_shrink_the_context_is_not_used() {
        let huge: &'static str = Box::leak("word ".repeat(2_000).into_boxed_str());
        let small: Vec<Turn> = (0..8).map(|i| Turn::new(i, Role::User, "a".repeat(300))).collect();
        let c = Compactor::new(policy(600, 2), Fixed(huge));
        assert!(matches!(c.compact(&small, &Pending::default(), None), Outcome::NoOp(NoOpReason::NoGain)));
    }

    /// Measured on a synthetic session; an estimate of the prompt, not a speed claim.
    #[test]
    fn synthetic_long_session_numbers() {
        let turns = session(200);
        let before = total_tokens(&turns);
        let policy = CompactionPolicy::for_window(Some(32_000));
        let c = Compactor::new(policy.clone(), Fixed("Files: src/mod0.rs..src/mod199.rs. Command: cargo test --lib. Decision: keep API stable. Error: E0425 in several modules. TODO: finish mod150-199."));
        let Outcome::Compacted { turns: out, record } = c.compact(&turns, &Pending::default(), None) else { panic!() };
        let after = total_tokens(&out);
        println!("compaction_numbers turns={} -> {} tokens={} -> {} threshold={}", turns.len(), out.len(), before, after, policy.threshold_tokens());
        assert!(before > policy.threshold_tokens() && after < policy.threshold_tokens());
        assert_eq!(record.tokens_before as usize, before);
        assert_eq!(record.tokens_after as usize, after);
        let all: String = out.iter().map(|t| t.text.as_str()).collect();
        for kept in ["You are Hub's coding agent", "src/mod199.rs", "cargo test --lib mod199", "src/mod0.rs", "TODO: finish mod150-199", "E0425"] {
            assert!(all.contains(kept), "{kept}");
        }
    }
}
