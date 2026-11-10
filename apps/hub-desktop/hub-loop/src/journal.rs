//! Durable, append-only per-session journal.
//!
//! Every session state change, model turn and tool call is appended here and
//! fsync'd BEFORE it is delivered to a client. After a crash, `replay` rebuilds
//! the session and `SessionState::plan` says what may happen next:
//!
//! - a read-only tool call without a result may be retried automatically;
//! - a side-effecting tool call without a result is NEVER re-run: it is
//!   surfaced as interrupted for the user to retry;
//! - an approval without a decision stays pending. Nothing here can approve.
//!
//! File format: one JSON record per line, each terminated by `\n`. A record is
//! committed only once its newline is on disk; a torn last record is ignored
//! (and cut off on the next open). A corrupt record that is followed by more
//! data is an error, not something to skip silently.
//!
//! The journal holds already-local session data. Secret-looking keys and
//! strings are redacted before they are written; callers should still not
//! hand it credentials.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// A record bigger than this (after string clamping) is replaced by a marker.
pub const MAX_RECORD_BYTES: usize = 64 * 1024;
/// Strings inside a payload are clamped to this many bytes.
pub const MAX_STRING_BYTES: usize = 4 * 1024;
/// Default cap for one session's file.
pub const MAX_SESSION_BYTES: u64 = 16 * 1024 * 1024;
const REDACTED: &str = "[redacted]";

#[derive(Debug)]
pub enum JournalError {
    Io(String),
    /// A committed record in the middle of the file is unreadable or out of order.
    Corrupt(String),
    /// The session file reached its size cap. Nothing was written.
    Full,
    InvalidId,
}

impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "journal_io:{e}"),
            Self::Corrupt(e) => write!(f, "journal_corrupt:{e}"),
            Self::Full => f.write_str("journal_full"),
            Self::InvalidId => f.write_str("journal_invalid_id"),
        }
    }
}
impl std::error::Error for JournalError {}
impl From<std::io::Error> for JournalError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Session,
    ModelTurnStart,
    ModelTurnDone,
    ToolCall,
    ToolResult,
    UserInput,
    ApprovalRequested,
    ApprovalDecided,
    Cancel,
    Done,
    /// Older turns were replaced by a summary. Committed BEFORE the summary is used.
    Compacted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub seq: u64,
    pub kind: Kind,
    pub payload: Value,
    pub timestamp_ms: u64,
}

/// Whether re-running a tool call can change anything outside the session.
/// Anything not explicitly read-only is a side effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    ReadOnly,
    SideEffect,
}

impl Effect {
    fn parse(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str) {
            Some("read_only") => Self::ReadOnly,
            _ => Self::SideEffect,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::SideEffect => "side_effect",
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------- redaction

fn secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    const PARTS: [&str; 12] = [
        "secret", "password", "passwd", "authorization", "cookie", "mnemonic", "seed", "credential",
        "private", "apikey", "api_key", "api-key",
    ];
    if PARTS.iter().any(|p| k.contains(p)) {
        return true;
    }
    if k.ends_with("key") && k != "key" && !k.ends_with("monkey") {
        return true;
    }
    k == "key" || (k.contains("token") && !k.ends_with("tokens"))
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '+' | '=')
}

/// Masks secret-looking substrings. Conservative on purpose: a few false
/// positives in a local journal are better than one stored key.
fn scrub_str(input: &str) -> String {
    if input.contains("-----BEGIN") {
        return REDACTED.into();
    }
    let mut s = input.to_owned();
    // prefix, minimum run length of token chars after it
    const PREFIXES: [(&str, usize); 9] = [
        ("sk-", 16), ("ghp_", 16), ("gho_", 16), ("github_pat_", 16), ("xoxb-", 16),
        ("xoxp-", 16), ("AKIA", 12), ("AIza", 16), ("Bearer ", 8),
    ];
    for (prefix, min) in PREFIXES {
        let mut from = 0;
        while let Some(rel) = s[from..].find(prefix) {
            let start = from + rel;
            let boundary = s[..start].chars().next_back().map_or(true, |c| !c.is_ascii_alphanumeric());
            let run: usize = s[start + prefix.len()..].chars().take_while(|c| token_char(*c)).map(char::len_utf8).sum();
            let run_chars = s[start + prefix.len()..start + prefix.len() + run].chars().count();
            if boundary && run_chars >= min {
                let end = start + prefix.len() + run;
                s.replace_range(start..end, REDACTED);
                from = start + REDACTED.len();
            } else {
                from = start + prefix.len();
            }
        }
    }
    // name=value pairs on command lines and URLs
    for name in ["password=", "passwd=", "secret=", "token=", "apikey=", "api_key=", "key=", "access_token="] {
        let mut from = 0;
        loop {
            let lower = s.to_ascii_lowercase();
            let Some(rel) = lower[from..].find(name) else { break };
            let value_start = from + rel + name.len();
            let end = s[value_start..]
                .find(|c: char| c.is_whitespace() || matches!(c, '&' | '"' | '\'' | ';'))
                .map_or(s.len(), |i| value_start + i);
            if end > value_start && &s[value_start..end] != REDACTED {
                s.replace_range(value_start..end, REDACTED);
            }
            from = value_start + REDACTED.len().min(s.len() - value_start);
            if from >= s.len() {
                break;
            }
        }
    }
    s
}

fn clamp(s: &str) -> String {
    if s.len() <= MAX_STRING_BYTES {
        return s.to_owned();
    }
    let mut end = MAX_STRING_BYTES;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated {} bytes]", &s[..end], s.len() - end)
}

/// Redacts secret-looking keys and strings and clamps long strings.
pub fn sanitize(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(clamp(&scrub_str(s))),
        Value::Array(items) => Value::Array(items.iter().take(256).map(sanitize).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), if secret_key(k) { json!(REDACTED) } else { sanitize(v) });
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

// ------------------------------------------------------------------ parsing

struct Parsed {
    records: Vec<Record>,
    /// Bytes of the committed prefix.
    valid_len: u64,
}

fn parse(bytes: &[u8]) -> Result<Parsed, JournalError> {
    let mut records: Vec<Record> = Vec::new();
    let mut pos = 0usize;
    let mut valid_len = 0usize;
    while pos < bytes.len() {
        let Some(nl) = bytes[pos..].iter().position(|b| *b == b'\n') else {
            break; // unterminated tail: never committed
        };
        let line = &bytes[pos..pos + nl];
        let next = pos + nl + 1;
        let record = serde_json::from_slice::<Record>(line).ok().filter(|r| r.seq == records.len() as u64 + 1);
        match record {
            Some(r) => {
                records.push(r);
                valid_len = next;
            }
            None if next >= bytes.len() => break, // torn final line
            None => {
                return Err(JournalError::Corrupt(format!("record {}", records.len() + 1)));
            }
        }
        pos = next;
    }
    Ok(Parsed { records, valid_len: valid_len as u64 })
}

/// Reads the committed records of a journal file. A torn tail is ignored.
pub fn read_records(path: &Path) -> Result<Vec<Record>, JournalError> {
    Ok(parse(&fs::read(path)?)?.records)
}

// ------------------------------------------------------------------ journal

struct Inner {
    file: File,
    next_seq: u64,
    bytes: u64,
}

pub struct Journal {
    path: PathBuf,
    max_bytes: u64,
    inner: Mutex<Inner>,
}

impl Journal {
    /// Opens or creates a journal. A torn tail from an earlier crash is cut off.
    pub fn open(path: impl Into<PathBuf>, max_bytes: u64) -> Result<Self, JournalError> {
        let path = path.into();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let existing = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let file = OpenOptions::new().create(true).read(true).write(true).open(&path)?;
        let (next_seq, bytes) = match existing {
            Some(bytes) => {
                let parsed = parse(&bytes)?;
                if parsed.valid_len < bytes.len() as u64 {
                    file.set_len(parsed.valid_len)?;
                    file.sync_all()?;
                }
                (parsed.records.len() as u64 + 1, parsed.valid_len)
            }
            None => {
                sync_dir(&path);
                (1, 0)
            }
        };
        let mut file = file;
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(bytes))?;
        Ok(Self { path, max_bytes, inner: Mutex::new(Inner { file, next_seq, bytes }) })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends one record and fsyncs it. Returns its `seq`. On error nothing
    /// is committed, and the caller must not deliver the event.
    pub fn append(&self, kind: Kind, payload: Value) -> Result<u64, JournalError> {
        let mut payload = sanitize(&payload);
        if serde_json::to_vec(&payload).map_or(true, |b| b.len() > MAX_RECORD_BYTES) {
            payload = json!({"truncated": true});
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let record = Record { seq: inner.next_seq, kind, payload, timestamp_ms: now_ms() };
        let mut line = serde_json::to_vec(&record).map_err(|e| JournalError::Io(e.to_string()))?;
        line.push(b'\n');
        if inner.bytes + line.len() as u64 > self.max_bytes {
            return Err(JournalError::Full);
        }
        let written = inner.file.write_all(&line).and_then(|_| inner.file.sync_data());
        if let Err(e) = written {
            // Best effort: drop a partial line so the next append stays aligned.
            let keep = inner.bytes;
            let _ = inner.file.set_len(keep);
            use std::io::Seek;
            let _ = inner.file.seek(std::io::SeekFrom::Start(keep));
            return Err(e.into());
        }
        inner.bytes += line.len() as u64;
        inner.next_seq += 1;
        Ok(record.seq)
    }

    pub fn replay(&self) -> Result<SessionState, JournalError> {
        Ok(SessionState::from_records(&read_records(&self.path)?))
    }

    // Typed helpers: they keep payload shapes in one place.

    pub fn session(&self, meta: Value) -> Result<u64, JournalError> {
        self.append(Kind::Session, meta)
    }
    pub fn user_input(&self, text: &str) -> Result<u64, JournalError> {
        self.append(Kind::UserInput, json!({"text": text}))
    }
    pub fn model_turn_start(&self, meta: Value) -> Result<u64, JournalError> {
        self.append(Kind::ModelTurnStart, meta)
    }
    pub fn model_turn_done(&self, meta: Value) -> Result<u64, JournalError> {
        self.append(Kind::ModelTurnDone, meta)
    }
    /// Journal BEFORE the tool starts. `detail` is a short locator, not content.
    pub fn tool_call(&self, call_id: &str, name: &str, effect: Effect, detail: Option<&str>) -> Result<u64, JournalError> {
        self.append(
            Kind::ToolCall,
            json!({"call_id": call_id, "name": name, "effect": effect.as_str(),
                   "idempotent": effect == Effect::ReadOnly, "detail": detail}),
        )
    }
    pub fn tool_result(&self, call_id: &str, ok: bool, preview: Option<&str>) -> Result<u64, JournalError> {
        self.append(Kind::ToolResult, json!({"call_id": call_id, "ok": ok, "preview": preview}))
    }
    pub fn approval_requested(&self, approval_id: &str, call_id: Option<&str>, tool: &str, summary: &str) -> Result<u64, JournalError> {
        self.append(
            Kind::ApprovalRequested,
            json!({"approval_id": approval_id, "call_id": call_id, "tool": tool, "summary": summary}),
        )
    }
    pub fn approval_decided(&self, approval_id: &str, approved: bool) -> Result<u64, JournalError> {
        self.append(Kind::ApprovalDecided, json!({"approval_id": approval_id, "approved": approved}))
    }
    /// Journal BEFORE the compacted context is used, so a resume rebuilds the same context.
    pub fn compacted(&self, c: &Compaction) -> Result<u64, JournalError> {
        self.append(Kind::Compacted, c.to_payload())
    }
    pub fn cancel(&self, reason: &str) -> Result<u64, JournalError> {
        self.append(Kind::Cancel, json!({"reason": reason}))
    }
    pub fn done(&self, status: &str, ok: bool) -> Result<u64, JournalError> {
        self.append(Kind::Done, json!({"status": status, "ok": ok}))
    }
}

#[cfg(unix)]
fn sync_dir(path: &Path) {
    if let Some(dir) = path.parent() {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
}
#[cfg(not(unix))]
fn sync_dir(_path: &Path) {}

// ------------------------------------------------------------------- replay

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Running,
    /// A cancel was recorded but the session was not closed with `done`.
    Cancelled,
    Done,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutcome {
    pub ok: bool,
    pub preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolRecord {
    pub call_id: String,
    pub name: String,
    pub effect: Effect,
    pub detail: Option<String>,
    pub result: Option<ToolOutcome>,
    pub seq: u64,
}

impl ToolRecord {
    /// Only read-only calls are idempotent.
    pub fn idempotent(&self) -> bool {
        self.effect == Effect::ReadOnly
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub approval_id: String,
    pub call_id: Option<String>,
    pub tool: String,
    pub summary: String,
    /// `None` means still pending. A decision is only ever read, never made, here.
    pub decision: Option<bool>,
    pub seq: u64,
}

/// One compaction: turns `covered_from..=covered_to` (caller-assigned turn
/// ids) were replaced by `summary`. Token counts are estimates.
#[derive(Clone, Debug, PartialEq)]
pub struct Compaction {
    pub covered_from: u64,
    pub covered_to: u64,
    pub covered_turns: u64,
    pub summary: String,
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub reason: String,
    /// Engine-specific id of the first entry kept after the summary (Pi), if any.
    pub first_kept: Option<String>,
}

impl Compaction {
    // Key names avoid "token": `sanitize` redacts such keys.
    fn to_payload(&self) -> Value {
        json!({"covered_from": self.covered_from, "covered_to": self.covered_to,
               "covered_turns": self.covered_turns, "summary": self.summary,
               "est_before": self.tokens_before, "est_after": self.tokens_after,
               "reason": self.reason, "first_kept": self.first_kept})
    }
    fn from_payload(p: &Value) -> Option<Self> {
        let n = |k: &str| p.get(k).and_then(Value::as_u64);
        Some(Self {
            covered_from: n("covered_from")?,
            covered_to: n("covered_to")?,
            covered_turns: n("covered_turns").unwrap_or(0),
            summary: text(p, "summary")?,
            tokens_before: n("est_before").unwrap_or(0),
            tokens_after: n("est_after").unwrap_or(0),
            reason: text(p, "reason").unwrap_or_default(),
            first_kept: text(p, "first_kept"),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionState {
    pub session: Option<Value>,
    pub status: Status,
    pub last_seq: u64,
    pub last_timestamp_ms: u64,
    pub turns_started: u32,
    pub turns_done: u32,
    pub user_inputs: Vec<String>,
    pub tools: Vec<ToolRecord>,
    pub approvals: Vec<Approval>,
    pub cancel_reason: Option<String>,
    /// Compactions in the order they were committed.
    pub compactions: Vec<Compaction>,
}

/// What a resumed session may do. Computed from the journal alone.
#[derive(Clone, Debug, PartialEq)]
pub struct ResumePlan {
    /// Read-only calls with no result: safe to run again automatically.
    pub retry: Vec<ToolRecord>,
    /// Side-effecting calls with no result: may or may not have happened.
    /// Never re-run automatically; the user decides.
    pub interrupted: Vec<ToolRecord>,
    /// Approvals nobody answered. They stay pending.
    pub pending_approvals: Vec<Approval>,
    /// A model turn started and never finished.
    pub open_turn: bool,
}

impl ResumePlan {
    pub fn is_empty(&self) -> bool {
        self.retry.is_empty() && self.interrupted.is_empty() && self.pending_approvals.is_empty() && !self.open_turn
    }
}

fn text(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_owned)
}

impl SessionState {
    pub fn from_records(records: &[Record]) -> Self {
        let mut s = Self {
            session: None,
            status: Status::Running,
            last_seq: 0,
            last_timestamp_ms: 0,
            turns_started: 0,
            turns_done: 0,
            user_inputs: Vec::new(),
            tools: Vec::new(),
            approvals: Vec::new(),
            cancel_reason: None,
            compactions: Vec::new(),
        };
        for r in records {
            s.last_seq = r.seq;
            s.last_timestamp_ms = r.timestamp_ms;
            let p = &r.payload;
            match r.kind {
                Kind::Session => s.session = Some(p.clone()),
                Kind::UserInput => s.user_inputs.push(text(p, "text").unwrap_or_default()),
                Kind::ModelTurnStart => s.turns_started += 1,
                Kind::ModelTurnDone => s.turns_done += 1,
                Kind::ToolCall => s.tools.push(ToolRecord {
                    call_id: text(p, "call_id").unwrap_or_default(),
                    name: text(p, "name").unwrap_or_default(),
                    effect: Effect::parse(p.get("effect")),
                    detail: text(p, "detail"),
                    result: None,
                    seq: r.seq,
                }),
                Kind::ToolResult => {
                    let id = text(p, "call_id").unwrap_or_default();
                    if let Some(t) = s.tools.iter_mut().rev().find(|t| t.call_id == id) {
                        t.result = Some(ToolOutcome {
                            ok: p.get("ok").and_then(Value::as_bool).unwrap_or(false),
                            preview: text(p, "preview"),
                        });
                    }
                }
                Kind::ApprovalRequested => s.approvals.push(Approval {
                    approval_id: text(p, "approval_id").unwrap_or_default(),
                    call_id: text(p, "call_id"),
                    tool: text(p, "tool").unwrap_or_default(),
                    summary: text(p, "summary").unwrap_or_default(),
                    decision: None,
                    seq: r.seq,
                }),
                Kind::ApprovalDecided => {
                    let id = text(p, "approval_id").unwrap_or_default();
                    // Only an explicit `true` approves; anything else is a denial.
                    let approved = p.get("approved").and_then(Value::as_bool) == Some(true);
                    if let Some(a) = s.approvals.iter_mut().rev().find(|a| a.approval_id == id && a.decision.is_none()) {
                        a.decision = Some(approved);
                    }
                }
                Kind::Cancel => {
                    s.cancel_reason = text(p, "reason");
                    if s.status == Status::Running {
                        s.status = Status::Cancelled;
                    }
                }
                Kind::Compacted => s.compactions.extend(Compaction::from_payload(p)),
                Kind::Done => s.status = Status::Done,
            }
        }
        s
    }

    pub fn is_finished(&self) -> bool {
        self.status == Status::Done
    }

    pub fn plan(&self) -> ResumePlan {
        let pending: Vec<Approval> = self.approvals.iter().filter(|a| a.decision.is_none()).cloned().collect();
        let unfinished: Vec<&ToolRecord> = self.tools.iter().filter(|t| t.result.is_none()).collect();
        // Calls parked on an unanswered approval did not start. An approval names
        // its call by id when it can; otherwise it belongs to the latest earlier
        // unfinished side-effecting call of the same tool.
        let mut waiting: Vec<u64> = Vec::new();
        for a in &pending {
            let hit = match a.call_id.as_deref() {
                Some(id) => unfinished.iter().find(|t| t.call_id == id),
                None => unfinished.iter().rev().find(|t| {
                    t.effect == Effect::SideEffect && t.name == a.tool && t.seq < a.seq && !waiting.contains(&t.seq)
                }),
            };
            if let Some(t) = hit {
                waiting.push(t.seq);
            }
        }
        let mut retry = Vec::new();
        let mut interrupted = Vec::new();
        for t in unfinished {
            if t.effect == Effect::ReadOnly {
                retry.push(t.clone());
            } else if !waiting.contains(&t.seq) {
                // Not waiting on a human, so it may have started: unknown outcome.
                interrupted.push(t.clone());
            }
        }
        ResumePlan {
            retry,
            interrupted,
            pending_approvals: pending,
            open_turn: self.turns_started > self.turns_done,
        }
    }
}

// -------------------------------------------------------------------- store

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A folder of per-session journals with size limits and pruning.
pub struct Store {
    dir: PathBuf,
    pub max_session_bytes: u64,
    pub max_total_bytes: u64,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), max_session_bytes: MAX_SESSION_BYTES, max_total_bytes: 128 * 1024 * 1024 }
    }

    fn file(&self, id: &str) -> Result<PathBuf, JournalError> {
        if !valid_id(id) {
            return Err(JournalError::InvalidId);
        }
        Ok(self.dir.join(format!("{id}.jsonl")))
    }

    /// Opens (creating if needed) the journal of one session.
    pub fn open(&self, id: &str) -> Result<Journal, JournalError> {
        Journal::open(self.file(id)?, self.max_session_bytes)
    }

    /// Opens a journal only if its file already exists.
    pub fn open_existing(&self, id: &str) -> Result<Option<Journal>, JournalError> {
        let path = self.file(id)?;
        if !path.is_file() {
            return Ok(None);
        }
        Journal::open(path, self.max_session_bytes).map(Some)
    }

    pub fn remove(&self, id: &str) -> Result<(), JournalError> {
        match fs::remove_file(self.file(id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// (id, state) for every readable journal. Corrupt files are skipped,
    /// never deleted.
    pub fn sessions(&self) -> Vec<(String, SessionState)> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Vec::new() };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")) else { continue };
            if !valid_id(id) {
                continue;
            }
            if let Ok(records) = read_records(&path) {
                out.push((id.to_owned(), SessionState::from_records(&records)));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Sessions that did not end with `done`.
    pub fn unfinished(&self) -> Vec<(String, SessionState)> {
        self.sessions().into_iter().filter(|(_, s)| !s.is_finished()).collect()
    }

    /// Deletes finished sessions, oldest first, until at most `keep_finished`
    /// remain and the folder fits `max_total_bytes`. Unfinished sessions are
    /// never touched. Returns how many were removed.
    pub fn prune_finished(&self, keep_finished: usize) -> usize {
        let mut finished: Vec<(String, u64, u64)> = self
            .sessions()
            .into_iter()
            .filter(|(_, s)| s.is_finished())
            .map(|(id, s)| {
                let size = self.file(&id).ok().and_then(|p| fs::metadata(p).ok()).map_or(0, |m| m.len());
                (id, s.last_timestamp_ms, size)
            })
            .collect();
        finished.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0))); // newest first
        let other_bytes: u64 = self
            .sessions()
            .into_iter()
            .filter(|(_, s)| !s.is_finished())
            .filter_map(|(id, _)| self.file(&id).ok().and_then(|p| fs::metadata(p).ok()))
            .map(|m| m.len())
            .sum();
        let mut total: u64 = other_bytes + finished.iter().map(|f| f.2).sum::<u64>();
        let mut removed = 0;
        while let Some((id, _, size)) = finished.last().cloned() {
            if finished.len() <= keep_finished && total <= self.max_total_bytes {
                break;
            }
            if self.remove(&id).is_ok() {
                removed += 1;
            }
            total = total.saturating_sub(size);
            finished.pop();
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("hub-loop-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn journal(dir: &Path) -> Journal {
        Journal::open(dir.join("s.jsonl"), MAX_SESSION_BYTES).unwrap()
    }

    #[test]
    fn append_and_replay_build_the_session() {
        let dir = temp();
        let j = journal(&dir);
        assert_eq!(j.session(json!({"model": "m"})).unwrap(), 1);
        j.user_input("hello").unwrap();
        j.model_turn_start(json!({})).unwrap();
        j.tool_call("c1", "hub_read", Effect::ReadOnly, Some("a.txt")).unwrap();
        j.tool_result("c1", true, Some("ok")).unwrap();
        j.model_turn_done(json!({})).unwrap();
        j.done("done", true).unwrap();
        drop(j);
        let state = journal(&dir).replay().unwrap();
        assert_eq!(state.last_seq, 7);
        assert_eq!(state.user_inputs, vec!["hello"]);
        assert_eq!(state.turns_started, 1);
        assert_eq!(state.turns_done, 1);
        assert!(state.is_finished());
        assert!(state.tools[0].idempotent());
        assert_eq!(state.tools[0].result.as_ref().unwrap().ok, true);
        assert!(state.plan().is_empty());
        // seq continues after reopening
        let j = journal(&dir);
        assert_eq!(j.cancel("x").unwrap(), 8);
    }

    #[test]
    fn truncated_last_record_is_ignored_and_cut_off() {
        let dir = temp();
        let j = journal(&dir);
        j.session(json!({})).unwrap();
        j.tool_call("c1", "hub_write", Effect::SideEffect, None).unwrap();
        drop(j);
        let path = dir.join("s.jsonl");
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(br#"{"seq":3,"kind":"tool_result","payload":{"call_id":"c1","ok":tr"#).unwrap();
        drop(f);
        assert_eq!(read_records(&path).unwrap().len(), 2, "torn tail ignored");
        let j = journal(&dir); // reopen repairs
        assert_eq!(j.tool_result("c1", true, None).unwrap(), 3);
        let records = read_records(&path).unwrap();
        assert_eq!(records.len(), 3);
        assert!(fs::read(&path).unwrap().ends_with(b"\n"));
    }

    #[test]
    fn complete_looking_record_without_newline_is_not_committed() {
        let dir = temp();
        let j = journal(&dir);
        j.session(json!({})).unwrap();
        drop(j);
        let path = dir.join("s.jsonl");
        let line = serde_json::to_string(&Record { seq: 2, kind: Kind::Done, payload: json!({}), timestamp_ms: 1 }).unwrap();
        OpenOptions::new().append(true).open(&path).unwrap().write_all(line.as_bytes()).unwrap();
        assert_eq!(read_records(&path).unwrap().len(), 1);
        assert!(!journal(&dir).replay().unwrap().is_finished());
    }

    #[test]
    fn corruption_in_the_middle_is_an_error_not_a_skip() {
        let dir = temp();
        let j = journal(&dir);
        j.session(json!({})).unwrap();
        j.user_input("a").unwrap();
        j.user_input("b").unwrap();
        drop(j);
        let path = dir.join("s.jsonl");
        let text = fs::read_to_string(&path).unwrap();
        let mut lines: Vec<&str> = text.lines().collect();
        lines[1] = "garbage";
        fs::write(&path, lines.join("\n") + "\n").unwrap();
        assert!(matches!(read_records(&path), Err(JournalError::Corrupt(_))));
        assert!(Journal::open(&path, MAX_SESSION_BYTES).is_err());
    }

    #[test]
    fn side_effecting_tool_without_result_is_interrupted_not_retried() {
        let dir = temp();
        let j = journal(&dir);
        j.session(json!({})).unwrap();
        j.tool_call("w1", "hub_write", Effect::SideEffect, Some("a.txt")).unwrap();
        drop(j);
        let plan = journal(&dir).replay().unwrap().plan();
        assert!(plan.retry.is_empty(), "a write is never retried automatically");
        assert_eq!(plan.interrupted.len(), 1);
        assert_eq!(plan.interrupted[0].call_id, "w1");
    }

    #[test]
    fn unknown_effect_counts_as_side_effect() {
        let dir = temp();
        let j = journal(&dir);
        j.append(Kind::ToolCall, json!({"call_id": "x", "name": "mystery"})).unwrap();
        j.append(Kind::ToolCall, json!({"call_id": "y", "name": "mystery", "effect": "nonsense"})).unwrap();
        let plan = j.replay().unwrap().plan();
        assert_eq!(plan.interrupted.len(), 2);
        assert!(plan.retry.is_empty());
    }

    #[test]
    fn read_only_tool_without_result_is_retried() {
        let dir = temp();
        let j = journal(&dir);
        j.tool_call("r1", "hub_read", Effect::ReadOnly, None).unwrap();
        j.tool_call("r2", "hub_read", Effect::ReadOnly, None).unwrap();
        j.tool_result("r2", true, None).unwrap();
        let plan = j.replay().unwrap().plan();
        assert_eq!(plan.retry.len(), 1);
        assert_eq!(plan.retry[0].call_id, "r1");
        assert!(plan.interrupted.is_empty());
    }

    #[test]
    fn approval_stays_pending_across_restart_and_is_never_auto_approved() {
        let dir = temp();
        let j = journal(&dir);
        j.session(json!({})).unwrap();
        j.tool_call("w1", "hub_write", Effect::SideEffect, None).unwrap();
        j.approval_requested("a1", Some("w1"), "hub_write", "write a.txt").unwrap();
        drop(j);
        let state = journal(&dir).replay().unwrap();
        let plan = state.plan();
        assert_eq!(plan.pending_approvals.len(), 1);
        assert_eq!(plan.pending_approvals[0].decision, None);
        assert!(plan.interrupted.is_empty(), "a call waiting on a human did not start");
        assert!(plan.retry.is_empty());
        // Opening again and even recording a cancel does not decide anything.
        let j = journal(&dir);
        j.cancel("interrupted_by_restart").unwrap();
        let plan = j.replay().unwrap().plan();
        assert_eq!(plan.pending_approvals.len(), 1);
        assert_eq!(plan.pending_approvals[0].decision, None);
        // An explicit decision is recorded as given; a malformed one is a denial.
        j.append(Kind::ApprovalDecided, json!({"approval_id": "a1", "approved": "yes"})).unwrap();
        let state = j.replay().unwrap();
        assert_eq!(state.approvals[0].decision, Some(false));
        assert!(state.plan().pending_approvals.is_empty());
    }

    #[test]
    fn approval_without_call_id_still_parks_its_own_call_only() {
        let dir = temp();
        let j = journal(&dir);
        j.tool_call("w1", "hub_write", Effect::SideEffect, None).unwrap(); // started, outcome unknown
        j.tool_call("e1", "hub_exec", Effect::SideEffect, None).unwrap(); // waits on a human
        j.approval_requested("a1", None, "hub_exec", "run").unwrap();
        let plan = j.replay().unwrap().plan();
        assert_eq!(plan.interrupted.iter().map(|t| t.call_id.as_str()).collect::<Vec<_>>(), vec!["w1"]);
        assert_eq!(plan.pending_approvals.len(), 1);
    }

    #[test]
    fn approved_but_unfinished_side_effect_is_interrupted() {
        let dir = temp();
        let j = journal(&dir);
        j.tool_call("w1", "hub_exec", Effect::SideEffect, None).unwrap();
        j.approval_requested("a1", Some("w1"), "hub_exec", "run").unwrap();
        j.approval_decided("a1", true).unwrap();
        let plan = j.replay().unwrap().plan();
        assert_eq!(plan.interrupted.len(), 1);
        assert!(plan.pending_approvals.is_empty());
    }

    #[test]
    fn open_turn_is_reported() {
        let dir = temp();
        let j = journal(&dir);
        j.model_turn_start(json!({})).unwrap();
        assert!(j.replay().unwrap().plan().open_turn);
        j.model_turn_done(json!({})).unwrap();
        assert!(!j.replay().unwrap().plan().open_turn);
    }

    #[test]
    fn secrets_are_not_written() {
        let dir = temp();
        let j = journal(&dir);
        j.session(json!({
            "api_key": "AAAA-not-for-disk-1111",
            "Authorization": "Bearer abcdefghijklmnop",
            "nested": {"password": "hunter2hunter2", "openai_key": "zzz"},
            "usage": {"input_tokens": 12},
        })).unwrap();
        j.user_input("use sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrst please").unwrap();
        j.tool_call("c", "hub_exec", Effect::SideEffect, Some("curl https://x/?token=SECRETVALUE&a=1 --password=hunter2hunter2")).unwrap();
        j.append(Kind::ModelTurnDone, json!({"pem": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"})).unwrap();
        drop(j);
        let raw = fs::read_to_string(dir.join("s.jsonl")).unwrap();
        for secret in ["AAAA-not-for-disk-1111", "abcdefghijklmnop", "hunter2hunter2", "sk-abcdefghijklmnopqrstuvwx",
            "ghp_abcdefghijklmnopqrst", "SECRETVALUE", "MIIB", "zzz"] {
            assert!(!raw.contains(secret), "{secret} leaked into the journal");
        }
        assert!(raw.contains("input_tokens"), "usage counters are not secrets");
        assert!(raw.contains("[redacted]"));
    }

    #[test]
    fn oversized_payloads_and_sessions_are_capped() {
        let dir = temp();
        let j = Journal::open(dir.join("s.jsonl"), 600).unwrap();
        let big = "x".repeat(100_000);
        let arr: Vec<Value> = (0..200).map(|_| json!(big.clone())).collect();
        j.append(Kind::UserInput, json!({"text": big, "more": arr})).unwrap();
        let records = read_records(&dir.join("s.jsonl")).unwrap();
        assert_eq!(records[0].payload, json!({"truncated": true}));
        let mut full = false;
        for _ in 0..50 {
            if matches!(j.user_input("padding padding padding"), Err(JournalError::Full)) {
                full = true;
                break;
            }
        }
        assert!(full, "session cap enforced");
        assert!(fs::metadata(dir.join("s.jsonl")).unwrap().len() <= 600);
    }

    #[test]
    fn prune_removes_old_finished_sessions_but_never_unfinished_ones() {
        let dir = temp();
        let mut store = Store::new(&dir);
        for (i, id) in ["a", "b", "c"].iter().enumerate() {
            let j = store.open(id).unwrap();
            j.session(json!({})).unwrap();
            // ensure distinct, ordered timestamps
            j.append(Kind::Done, json!({})).unwrap();
            let path = dir.join(format!("{id}.jsonl"));
            let mut recs = read_records(&path).unwrap();
            for r in &mut recs { r.timestamp_ms = 1000 + i as u64; }
            let body: String = recs.iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect();
            drop(j);
            fs::write(&path, body).unwrap();
        }
        let live = store.open("live").unwrap();
        live.session(json!({})).unwrap();
        live.tool_call("w", "hub_write", Effect::SideEffect, None).unwrap();
        assert_eq!(store.prune_finished(1), 2);
        let ids: Vec<String> = store.sessions().into_iter().map(|s| s.0).collect();
        assert_eq!(ids, vec!["c", "live"], "newest finished and the unfinished one stay");
        assert_eq!(store.unfinished().len(), 1);
        store.max_total_bytes = 0;
        assert_eq!(store.prune_finished(10), 1);
        assert_eq!(store.unfinished().len(), 1, "unfinished sessions survive any cap");
    }

    #[test]
    fn ids_cannot_escape_the_folder() {
        let store = Store::new(temp());
        assert!(matches!(store.open("../x"), Err(JournalError::InvalidId)));
        assert!(matches!(store.open("a/b"), Err(JournalError::InvalidId)));
        assert!(matches!(store.open(""), Err(JournalError::InvalidId)));
    }
}
