//! Bounded, memory-only next-run state. Root owns authentication, anchor proof and launching.
use super::WorkEngine;
use serde::{Deserialize, Serialize};
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const INVALID: &str = "pi_work_queue_invalid_request";
const CONTEXT: &str = "pi_work_queue_context_changed";
const REVISION: &str = "pi_work_queue_revision_conflict";
const CONFLICT: &str = "pi_work_queue_request_conflict";
const STATE: &str = "pi_work_queue_state_conflict";
const LIMIT: &str = "pi_work_queue_limit";
const UNAVAILABLE: &str = "pi_work_queue_unavailable";
const MAX_PENDING: usize = 8;
const MAX_RECORDS: usize = 32;
const MAX_TEXT: usize = 8000;
const MAX_TOTAL: usize = 32768;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Permissions {
    pub allow_write: bool,
    pub allow_exec: bool,
    pub allow_http: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Context {
    pub token: String,
    pub workspace: String,
    pub model: String,
    pub engine: WorkEngine,
    pub permissions: Permissions,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum QueueState {
    Queued,
    Held,
    Starting,
    Running,
    Done,
    Failed,
    Cancelled,
    Unknown,
}
impl QueueState {
    fn editable(self) -> bool {
        matches!(self, Self::Queued | Self::Held)
    }
    fn pending(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Held | Self::Starting | Self::Unknown
        )
    }
    fn terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Item {
    pub queue_id: String,
    pub request_id: String,
    pub user_message_id: String,
    pub anchor_run_id: String,
    pub workspace: String,
    pub text: String,
    pub model: String,
    pub engine: WorkEngine,
    pub permissions: Permissions,
    pub position: usize,
    pub held: bool,
    pub requested_at_ms: u64,
    pub state: QueueState,
    pub native_run_id: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    pub context: Option<Context>,
    pub revision: u64,
    pub available: bool,
    pub items: Vec<Item>,
}
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub context: String,
    pub request_id: String,
    pub revision: u64,
    pub queue_id: String,
    pub applied: bool,
}
#[derive(Clone)]
pub(super) struct Anchor {
    pub run_id: String,
    pub requested_run_id: Option<String>,
    pub workspace: String,
    pub model: String,
    pub engine: WorkEngine,
    pub permissions: Permissions,
    pub ready: bool,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Operation {
    pub context: String,
    pub request_id: String,
    pub expected_revision: u64,
    pub kind: OperationKind,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) enum OperationKind {
    Enqueue {
        text: String,
    },
    Edit {
        queue_id: String,
        text: String,
    },
    Cancel {
        queue_id: String,
    },
    Reorder {
        queue_id: String,
        before_queue_id: Option<String>,
    },
    Resume {
        queue_id: String,
    },
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Claim {
    pub item: Item,
    pub context: String,
    pub revision: u64,
    token: String,
}
struct Entry {
    context: String,
    item: Item,
    claim: Option<Claim>,
}
struct Ledger {
    context: String,
    request_id: String,
    kind: OperationKind,
    anchor_run_id: Option<String>,
    receipt: Receipt,
}
#[derive(Default)]
pub(super) struct QueueStore {
    context: Option<Context>,
    revision: u64,
    available: bool,
    entries: Vec<Entry>,
    ledger: Vec<Ledger>,
}

fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|v| {
        value.len() == 36
            && v.to_string() == value
            && v.get_version_num() == 4
            && v.get_variant() == uuid::Variant::RFC4122
    })
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn valid_text(value: &str) -> bool {
    !value.contains('\0')
        && !value.trim_matches(whitespace).is_empty()
        && value.encode_utf16().count() <= MAX_TEXT
        && !value.trim().is_empty()
        && value.trim().encode_utf16().count() <= MAX_TEXT
}
fn valid_workspace(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 8192
        && !value.chars().any(char::is_control)
}
fn valid_model(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|c| (0x21..=0x7e).contains(&c))
}
fn valid_context(context: &Context) -> bool {
    uuid(&context.token)
        && valid_workspace(&context.workspace)
        && valid_model(&context.model)
        && !context.permissions.allow_write
}
impl QueueStore {
    pub(super) fn snapshot(&self) -> Snapshot {
        Snapshot {
            context: self.context.clone(),
            revision: self.revision,
            available: self.available && self.context.is_some(),
            items: self
                .entries
                .iter()
                .map(|entry| entry.item.clone())
                .collect(),
        }
    }
    fn next_revision(&self) -> Result<u64, String> {
        self.revision
            .checked_add(1)
            .filter(|v| *v <= MAX_SAFE)
            .ok_or_else(|| LIMIT.into())
    }
    fn lifecycle_revision(&mut self) -> u64 {
        let revision = self.revision.saturating_add(1).min(MAX_SAFE);
        if revision == MAX_SAFE {
            self.available = false;
            self.hold(None);
        }
        revision
    }
    fn positions(&mut self) {
        for (index, entry) in self.entries.iter_mut().enumerate() {
            entry.item.position = index + 1;
        }
    }
    fn hold(&mut self, workspace: Option<&str>) {
        for entry in &mut self.entries {
            if entry.item.state.editable() && workspace.is_none_or(|v| v == entry.item.workspace) {
                entry.item.state = QueueState::Held;
                entry.item.held = true;
            }
        }
    }
    fn context(&self, token: &str) -> Result<&Context, String> {
        if !uuid(token) {
            return Err(INVALID.into());
        }
        let context = self
            .context
            .as_ref()
            .filter(|v| v.token == token)
            .ok_or(CONTEXT)?;
        if !self.available {
            return Err(UNAVAILABLE.into());
        }
        Ok(context)
    }
    pub(super) fn set_context(
        &mut self,
        context: Option<Context>,
        available: bool,
    ) -> Result<Snapshot, String> {
        if context.as_ref().is_some_and(|v| !valid_context(v)) || available && context.is_none() {
            return Err(INVALID.into());
        }
        if self.context == context && self.available == available {
            return Ok(self.snapshot());
        }
        if self
            .context
            .as_ref()
            .zip(context.as_ref())
            .is_some_and(|(old, new)| old.token == new.token && old != new)
        {
            return Err(CONTEXT.into());
        }
        let revision = self.lifecycle_revision();
        let changed = self.context.as_ref().map(|v| &v.token) != context.as_ref().map(|v| &v.token);
        self.hold(None);
        if changed {
            let retired = self
                .entries
                .iter()
                .filter(|e| e.item.state.terminal())
                .map(|e| e.item.queue_id.clone())
                .collect::<Vec<_>>();
            self.entries.retain(|e| !e.item.state.terminal());
            self.ledger
                .retain(|l| !retired.contains(&l.receipt.queue_id));
        }
        self.context = context;
        self.available = available && revision < MAX_SAFE;
        self.revision = revision;
        self.positions();
        Ok(self.snapshot())
    }
    fn anchor(&self, anchor: &Anchor, context: &Context) -> Result<(), String> {
        if !uuid(&anchor.run_id)
            || anchor.requested_run_id.as_ref().is_some_and(|id| !uuid(id))
            || !valid_workspace(&anchor.workspace)
            || !valid_model(&anchor.model)
        {
            return Err(INVALID.into());
        }
        if anchor.workspace != context.workspace || anchor.engine != context.engine {
            return Err(CONTEXT.into());
        }
        Ok(())
    }
    fn index(&self, queue_id: &str) -> Result<usize, String> {
        if !uuid(queue_id) {
            return Err(INVALID.into());
        }
        self.entries
            .iter()
            .position(|e| e.item.queue_id == queue_id)
            .ok_or_else(|| STATE.into())
    }
    fn editable(&self, index: usize) -> Result<(), String> {
        if self.entries[index].item.state.editable() {
            Ok(())
        } else {
            Err(STATE.into())
        }
    }
    fn text_capacity(&self, index: Option<usize>, text: &str) -> Result<(), String> {
        if !valid_text(text) {
            return Err(INVALID.into());
        }
        let total = self
            .entries
            .iter()
            .enumerate()
            .filter(|(i, e)| Some(*i) != index && e.item.state.pending())
            .map(|(_, e)| e.item.text.encode_utf16().count())
            .sum::<usize>();
        if total + text.encode_utf16().count() > MAX_TOTAL {
            Err(LIMIT.into())
        } else {
            Ok(())
        }
    }
    pub(super) fn apply(
        &mut self,
        operation: Operation,
        anchor: Option<&Anchor>,
        now_ms: u64,
    ) -> Result<Receipt, String> {
        let context = self.context(&operation.context)?.clone();
        if !uuid(&operation.request_id)
            || operation.expected_revision > MAX_SAFE
            || now_ms > MAX_SAFE
        {
            return Err(INVALID.into());
        }
        let anchor_run_id = if matches!(
            &operation.kind,
            OperationKind::Enqueue { .. } | OperationKind::Resume { .. }
        ) {
            let anchor = anchor.ok_or(INVALID)?;
            Some(
                anchor
                    .requested_run_id
                    .as_ref()
                    .unwrap_or(&anchor.run_id)
                    .clone(),
            )
        } else {
            None
        };
        if let Some(known) = self
            .ledger
            .iter()
            .find(|l| l.context == operation.context && l.request_id == operation.request_id)
        {
            return if known.kind == operation.kind && known.anchor_run_id == anchor_run_id {
                Ok(known.receipt.clone())
            } else {
                Err(CONFLICT.into())
            };
        }
        if self
            .ledger
            .iter()
            .any(|l| l.request_id == operation.request_id)
        {
            return Err(CONFLICT.into());
        }
        if operation.expected_revision != self.revision {
            return Err(REVISION.into());
        }
        if self.ledger.len() >= MAX_RECORDS {
            return Err(LIMIT.into());
        }
        let revision = self.next_revision()?;
        let queue_id = match &operation.kind {
            OperationKind::Enqueue { text } => {
                let anchor = anchor.ok_or(INVALID)?;
                self.anchor(anchor, &context)?;
                self.text_capacity(None, text)?;
                if self.entries.len() >= MAX_RECORDS
                    || self
                        .entries
                        .iter()
                        .filter(|e| e.item.state.pending())
                        .count()
                        >= MAX_PENDING
                {
                    return Err(LIMIT.into());
                }
                let queue_id = uuid::Uuid::new_v4().to_string();
                self.entries.push(Entry {
                    context: context.token.clone(),
                    claim: None,
                    item: Item {
                        queue_id: queue_id.clone(),
                        request_id: operation.request_id.clone(),
                        user_message_id: uuid::Uuid::new_v4().to_string(),
                        anchor_run_id: anchor.run_id.clone(),
                        workspace: context.workspace.clone(),
                        text: text.trim().to_owned(),
                        model: context.model.clone(),
                        engine: context.engine,
                        permissions: context.permissions.clone(),
                        position: 0,
                        held: false,
                        requested_at_ms: now_ms,
                        state: QueueState::Queued,
                        native_run_id: None,
                    },
                });
                queue_id
            }
            OperationKind::Edit { queue_id, text } => {
                let index = self.index(queue_id)?;
                self.editable(index)?;
                self.text_capacity(Some(index), text)?;
                self.entries[index].item.text = text.trim().to_owned();
                queue_id.clone()
            }
            OperationKind::Cancel { queue_id } => {
                let index = self.index(queue_id)?;
                self.editable(index)?;
                self.entries[index].item.state = QueueState::Cancelled;
                self.entries[index].item.held = false;
                queue_id.clone()
            }
            OperationKind::Reorder {
                queue_id,
                before_queue_id,
            } => {
                let index = self.index(queue_id)?;
                self.editable(index)?;
                if let Some(before) = before_queue_id {
                    if before == queue_id {
                        return Err(INVALID.into());
                    }
                    let target = self.index(before)?;
                    self.editable(target)?;
                }
                let entry = self.entries.remove(index);
                let position = before_queue_id
                    .as_ref()
                    .and_then(|id| self.entries.iter().position(|e| e.item.queue_id == *id))
                    .unwrap_or(self.entries.len());
                self.entries.insert(position, entry);
                queue_id.clone()
            }
            OperationKind::Resume { queue_id } => {
                let index = self.index(queue_id)?;
                if self.entries[index].item.state != QueueState::Held {
                    return Err(STATE.into());
                }
                let anchor = anchor.ok_or(INVALID)?;
                self.anchor(anchor, &context)?;
                if self.entries[index].item.workspace != context.workspace
                    || self.entries[index].item.model != context.model
                    || self.entries[index].item.engine != context.engine
                    || self.entries[index].item.permissions != context.permissions
                {
                    return Err(CONTEXT.into());
                }
                self.entries[index].context = context.token.clone();
                self.entries[index].item.anchor_run_id = anchor.run_id.clone();
                self.entries[index].item.state = QueueState::Queued;
                self.entries[index].item.held = false;
                queue_id.clone()
            }
        };
        self.revision = revision;
        self.positions();
        let receipt = Receipt {
            context: context.token,
            request_id: operation.request_id.clone(),
            revision,
            queue_id,
            applied: true,
        };
        self.ledger.push(Ledger {
            context: operation.context,
            request_id: operation.request_id,
            kind: operation.kind,
            anchor_run_id,
            receipt: receipt.clone(),
        });
        Ok(receipt)
    }
    /// Resolve only registered execution edges. Root still proves the returned real run.
    pub(super) fn execution_anchor(&self, source_run_id: &str) -> Result<String, String> {
        if !uuid(source_run_id) {
            return Err(INVALID.into());
        }
        let context = self
            .context
            .as_ref()
            .filter(|_| self.available)
            .ok_or(UNAVAILABLE)?;
        let mut current = source_run_id.to_owned();
        let mut seen = std::collections::HashSet::new();
        for step in 0..=MAX_RECORDS {
            if !seen.insert(current.clone()) {
                return Err(STATE.into());
            }
            if self.entries.iter().any(|entry| {
                entry.context != context.token
                    && entry.item.native_run_id.is_some()
                    && (entry.item.anchor_run_id == current
                        || entry.item.native_run_id.as_deref() == Some(current.as_str()))
            }) {
                return Err(CONTEXT.into());
            }
            let mut children = self
                .entries
                .iter()
                .filter(|entry| {
                    entry.context == context.token && entry.item.anchor_run_id == current
                })
                .filter_map(|entry| entry.item.native_run_id.as_ref());
            let Some(next) = children.next() else {
                return Ok(current);
            };
            if children.next().is_some() || step == MAX_RECORDS || !uuid(next) {
                return Err(STATE.into());
            }
            current = next.clone();
        }
        Err(STATE.into())
    }
    pub(super) fn next_ready(&self) -> Option<Item> {
        let context = self.context.as_ref().filter(|_| self.available)?;
        if self.entries.iter().any(|e| {
            e.item.workspace == context.workspace
                && matches!(
                    e.item.state,
                    QueueState::Starting | QueueState::Running | QueueState::Unknown
                )
        }) {
            return None;
        }
        self.entries
            .iter()
            .find(|e| {
                e.context == context.token && e.item.state == QueueState::Queued && !e.item.held
            })
            .map(|e| e.item.clone())
    }
    pub(super) fn begin_start(
        &mut self,
        context: &str,
        expected_revision: u64,
        anchor: &Anchor,
    ) -> Result<Claim, String> {
        let current = self.context(context)?.clone();
        if expected_revision != self.revision {
            return Err(REVISION.into());
        }
        self.anchor(anchor, &current)?;
        if !anchor.ready {
            return Err(STATE.into());
        }
        let item = self.next_ready().ok_or(STATE)?;
        if item.anchor_run_id != anchor.run_id {
            return Err(STATE.into());
        }
        let index = self.index(&item.queue_id)?;
        let revision = self.next_revision()?;
        self.entries[index].item.state = QueueState::Starting;
        let claim = Claim {
            item: self.entries[index].item.clone(),
            context: context.into(),
            revision,
            token: uuid::Uuid::new_v4().to_string(),
        };
        self.entries[index].claim = Some(claim.clone());
        self.revision = revision;
        Ok(claim)
    }
    fn claimed(&self, claim: &Claim) -> Result<usize, String> {
        let index = self.index(&claim.item.queue_id)?;
        if self.entries[index].claim.as_ref() != Some(claim) {
            return Err(STATE.into());
        }
        Ok(index)
    }
    pub(super) fn registered(
        &mut self,
        claim: &Claim,
        native_run_id: &str,
    ) -> Result<Snapshot, String> {
        let index = self.claimed(claim)?;
        if !uuid(native_run_id)
            || [
                &claim.item.queue_id,
                &claim.item.request_id,
                &claim.item.user_message_id,
                &claim.item.anchor_run_id,
            ]
            .iter()
            .any(|v| v.as_str() == native_run_id)
        {
            return Err(INVALID.into());
        }
        if let Some(actual) = &self.entries[index].item.native_run_id {
            return if actual == native_run_id {
                Ok(self.snapshot())
            } else {
                Err(STATE.into())
            };
        }
        if !matches!(
            self.entries[index].item.state,
            QueueState::Starting | QueueState::Unknown
        ) || self
            .entries
            .iter()
            .any(|e| e.item.native_run_id.as_deref() == Some(native_run_id))
        {
            return Err(STATE.into());
        }
        let revision = self.lifecycle_revision();
        let current = self
            .context
            .as_ref()
            .is_some_and(|c| c.token == claim.context)
            && self.available;
        self.entries[index].item.native_run_id = Some(native_run_id.into());
        self.entries[index].item.state = QueueState::Running;
        self.entries[index].item.held = false;
        if !current {
            self.hold(Some(&claim.item.workspace));
        }
        self.revision = revision;
        Ok(self.snapshot())
    }
    pub(super) fn not_started(&mut self, claim: &Claim) -> Result<Snapshot, String> {
        let index = self.claimed(claim)?;
        if self.entries[index].item.native_run_id.is_some() {
            return Ok(self.snapshot());
        }
        if self.entries[index].item.state != QueueState::Starting {
            return Err(STATE.into());
        }
        let revision = self.lifecycle_revision();
        self.entries[index].item.state = QueueState::Held;
        self.entries[index].item.held = true;
        self.entries[index].claim = None;
        self.hold(Some(&claim.item.workspace));
        self.revision = revision;
        Ok(self.snapshot())
    }
    pub(super) fn unknown(&mut self, claim: &Claim) -> Result<Snapshot, String> {
        let index = self.claimed(claim)?;
        if self.entries[index].item.native_run_id.is_some() {
            return Ok(self.snapshot());
        }
        if self.entries[index].item.state == QueueState::Unknown {
            return Ok(self.snapshot());
        }
        if self.entries[index].item.state != QueueState::Starting {
            return Err(STATE.into());
        }
        let revision = self.lifecycle_revision();
        self.entries[index].item.state = QueueState::Unknown;
        self.entries[index].item.held = true;
        self.hold(Some(&claim.item.workspace));
        self.revision = revision;
        Ok(self.snapshot())
    }
    pub(super) fn finish(
        &mut self,
        native_run_id: &str,
        phase: QueueState,
        continuation_available: bool,
    ) -> Result<Snapshot, String> {
        if !uuid(native_run_id) || !phase.terminal() {
            return Err(INVALID.into());
        }
        let registered = self
            .entries
            .iter()
            .position(|e| e.item.native_run_id.as_deref() == Some(native_run_id));
        let predecessor = registered
            .map(|i| self.entries[i].item.anchor_run_id.clone())
            .unwrap_or_else(|| native_run_id.into());
        let indices = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                e.item.state.editable()
                    && (e.item.anchor_run_id == predecessor
                        || e.item.anchor_run_id == native_run_id)
            })
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if registered.is_none() && indices.is_empty() {
            return Ok(self.snapshot());
        }
        if registered.is_some_and(|i| self.entries[i].item.state.terminal()) {
            return Ok(self.snapshot());
        }
        let revision = self.lifecycle_revision();
        let success = phase == QueueState::Done && continuation_available;
        if let Some(index) = registered {
            self.entries[index].item.state = phase;
            self.entries[index].item.held = false;
        }
        for index in indices {
            if success {
                if self.entries[index].item.state == QueueState::Queued {
                    self.entries[index].item.anchor_run_id = native_run_id.into();
                }
            } else {
                self.entries[index].item.state = QueueState::Held;
                self.entries[index].item.held = true;
            }
        }
        self.revision = revision;
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn uid(n: u32) -> String {
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    fn context() -> Context {
        Context {
            token: uid(1),
            workspace: "/fixture".into(),
            model: "ollama/local-model".into(),
            engine: WorkEngine::Thin,
            permissions: Permissions {
                allow_write: false,
                allow_exec: true,
                allow_http: true,
            },
        }
    }
    fn anchor() -> Anchor {
        Anchor {
            run_id: uid(2),
            requested_run_id: None,
            workspace: "/fixture".into(),
            model: "ollama/old-model".into(),
            engine: WorkEngine::Thin,
            permissions: Permissions {
                allow_write: true,
                allow_exec: false,
                allow_http: false,
            },
            ready: true,
        }
    }
    fn store() -> QueueStore {
        let mut store = QueueStore::default();
        store.set_context(Some(context()), true).unwrap();
        store
    }
    fn operation(store: &QueueStore, n: u32, kind: OperationKind) -> Operation {
        Operation {
            context: store.context.as_ref().unwrap().token.clone(),
            request_id: uid(n),
            expected_revision: store.revision,
            kind,
        }
    }
    fn enqueue(store: &mut QueueStore, n: u32, text: &str) -> Receipt {
        let op = operation(store, n, OperationKind::Enqueue { text: text.into() });
        store.apply(op, Some(&anchor()), 1000).unwrap()
    }
    fn mutate(store: &mut QueueStore, n: u32, kind: OperationKind) -> Result<Receipt, String> {
        let op = operation(store, n, kind);
        store.apply(op, Some(&anchor()), 1001)
    }

    #[test]
    fn dto_is_closed_uses_native_ids_and_fresh_permissions_not_anchor_grants() {
        let mut store = store();
        let receipt = enqueue(&mut store, 10, " literal <script> ");
        let snapshot = store.snapshot();
        let item = &snapshot.items[0];
        assert!(uuid(&item.queue_id) && uuid(&item.user_message_id));
        assert_ne!(item.queue_id, item.request_id);
        assert_eq!(item.request_id, uid(10));
        assert_eq!(item.position, 1);
        assert_eq!(item.text, "literal <script>");
        assert!(
            !item.permissions.allow_write
                && item.permissions.allow_exec
                && item.permissions.allow_http
        );
        assert_eq!(item.model, "ollama/local-model");
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 4);
        assert!(wire.get("context").is_some());
        assert_eq!(wire["items"][0].as_object().unwrap().len(), 14);
        let wire = serde_json::to_value(receipt).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 5);
        assert_eq!(wire["context"], json!(uid(1)));
        assert_eq!(wire["applied"], true);
        assert!(wire.get("text").is_none());
        let mut invalid = serde_json::to_value(context()).unwrap();
        invalid["script"] = json!("not allowed");
        assert!(serde_json::from_value::<Context>(invalid).is_err());
    }

    #[test]
    fn eight_pending_is_inclusive_and_ninth_never_changes_state() {
        let mut store = store();
        for n in 10..18 {
            enqueue(&mut store, n, "task");
        }
        let before = store.revision;
        assert_eq!(store.snapshot().items.len(), 8);
        assert_eq!(
            mutate(
                &mut store,
                18,
                OperationKind::Enqueue {
                    text: "ninth".into()
                }
            )
            .err()
            .unwrap(),
            LIMIT
        );
        assert_eq!(store.revision, before);
        let cancelled = store.entries[0].item.queue_id.clone();
        mutate(
            &mut store,
            19,
            OperationKind::Cancel {
                queue_id: cancelled,
            },
        )
        .unwrap();
        enqueue(&mut store, 20, "replacement");
        assert_eq!(
            store
                .entries
                .iter()
                .filter(|e| e.item.state.pending())
                .count(),
            8
        );
    }

    #[test]
    fn utf16_text_total_and_unicode_boundaries_are_exact() {
        assert!(valid_text(&"😀".repeat(4000)));
        assert!(!valid_text(&format!("{}a", "😀".repeat(4000))));
        for text in ["", " \r\n\t", "\u{feff}", "a\0"] {
            assert!(!valid_text(text));
        }
        assert!(serde_json::from_slice::<Context>(b"{\"token\":\"\\ud800\"}").is_err());
        let mut store = store();
        for n in 10..14 {
            enqueue(&mut store, n, &"a".repeat(8000));
        }
        enqueue(&mut store, 14, &"b".repeat(768));
        assert_eq!(
            mutate(&mut store, 15, OperationKind::Enqueue { text: "x".into() })
                .err()
                .unwrap(),
            LIMIT
        );
        let id = store.entries[4].item.queue_id.clone();
        assert_eq!(
            mutate(
                &mut store,
                16,
                OperationKind::Edit {
                    queue_id: id.clone(),
                    text: "b".repeat(769)
                }
            )
            .err()
            .unwrap(),
            LIMIT
        );
        mutate(
            &mut store,
            17,
            OperationKind::Edit {
                queue_id: id,
                text: "b".repeat(767),
            },
        )
        .unwrap();
        enqueue(&mut store, 18, "x");
    }

    #[test]
    fn same_request_returns_original_receipt_despite_later_revision_but_changed_text_or_anchor_conflicts(
    ) {
        let mut store = store();
        let op = operation(
            &store,
            10,
            OperationKind::Enqueue {
                text: "original".into(),
            },
        );
        let receipt = store.apply(op.clone(), Some(&anchor()), 1000).unwrap();
        enqueue(&mut store, 11, "later");
        let revision = store.revision;
        let mut retry = op.clone();
        retry.expected_revision = revision;
        assert!(store.apply(retry, Some(&anchor()), 2000).unwrap() == receipt);
        assert_eq!(store.entries.len(), 2);
        assert_eq!(store.revision, revision);
        let mut changed = op.clone();
        changed.kind = OperationKind::Enqueue {
            text: "altered".into(),
        };
        assert_eq!(
            store.apply(changed, Some(&anchor()), 2000).err().unwrap(),
            CONFLICT
        );
        let mut changed_anchor = anchor();
        changed_anchor.run_id = uid(3);
        assert_eq!(
            store
                .apply(op.clone(), Some(&changed_anchor), 2000)
                .err()
                .unwrap(),
            CONFLICT
        );
        let mut ready_changed = anchor();
        ready_changed.ready = false;
        assert!(store.apply(op, Some(&ready_changed), 2000).unwrap() == receipt);
    }

    #[test]
    fn context_revision_uuid_model_workspace_and_clock_fail_before_mutation() {
        let mut store = store();
        let mut op = operation(
            &store,
            10,
            OperationKind::Enqueue {
                text: "task".into(),
            },
        );
        op.context = uid(99);
        assert_eq!(
            store.apply(op, Some(&anchor()), 1000).err().unwrap(),
            CONTEXT
        );
        let mut op = operation(
            &store,
            10,
            OperationKind::Enqueue {
                text: "task".into(),
            },
        );
        op.expected_revision = 0;
        assert_eq!(
            store.apply(op, Some(&anchor()), 1000).err().unwrap(),
            REVISION
        );
        for id in [
            "bad",
            "00000000-0000-1000-8000-000000000001",
            "00000000-0000-4000-7000-000000000001",
        ] {
            let mut op = operation(
                &store,
                10,
                OperationKind::Enqueue {
                    text: "task".into(),
                },
            );
            op.request_id = id.into();
            assert_eq!(
                store.apply(op, Some(&anchor()), 1000).err().unwrap(),
                INVALID
            );
        }
        let op = operation(
            &store,
            10,
            OperationKind::Enqueue {
                text: "task".into(),
            },
        );
        assert_eq!(
            store
                .apply(op, Some(&anchor()), MAX_SAFE + 1)
                .err()
                .unwrap(),
            INVALID
        );
        for field in [0, 1, 2, 3] {
            let mut context = context();
            match field {
                0 => context.model = "a".repeat(65),
                1 => context.workspace = "nul\0".into(),
                2 => context.permissions.allow_write = true,
                _ => context.token = "bad".into(),
            };
            assert_eq!(
                store.set_context(Some(context), true).err().unwrap(),
                INVALID
            );
        }
        assert!(store.entries.is_empty());
    }

    #[test]
    fn changed_context_holds_pending_preserves_text_and_only_explicit_matching_resume_enables() {
        let mut store = store();
        let receipt = enqueue(&mut store, 10, "kept");
        let mut context = context();
        context.token = uid(4);
        store.set_context(Some(context.clone()), true).unwrap();
        assert_eq!(store.entries[0].item.state, QueueState::Held);
        assert_eq!(store.entries[0].item.text, "kept");
        assert!(store.next_ready().is_none());
        let op = Operation {
            context: uid(1),
            request_id: uid(10),
            expected_revision: 1,
            kind: OperationKind::Enqueue {
                text: "kept".into(),
            },
        };
        assert_eq!(
            store.apply(op, Some(&anchor()), 1000).err().unwrap(),
            CONTEXT
        );
        mutate(
            &mut store,
            11,
            OperationKind::Resume {
                queue_id: receipt.queue_id,
            },
        )
        .unwrap();
        assert!(store.next_ready().is_some());
        context.token = uid(5);
        context.model = "ollama/other".into();
        store.set_context(Some(context), true).unwrap();
        let id = store.entries[0].item.queue_id.clone();
        assert_eq!(
            mutate(&mut store, 12, OperationKind::Resume { queue_id: id })
                .err()
                .unwrap(),
            CONTEXT
        );
    }

    #[test]
    fn resume_request_anchor_is_part_of_idempotent_payload() {
        let mut store = store();
        let first = enqueue(&mut store, 10, "task");
        let mut context = context();
        context.token = uid(4);
        store.set_context(Some(context), true).unwrap();
        let op = operation(
            &store,
            11,
            OperationKind::Resume {
                queue_id: first.queue_id,
            },
        );
        let receipt = store.apply(op.clone(), Some(&anchor()), 1000).unwrap();
        let mut different = anchor();
        different.run_id = uid(3);
        assert!(store.apply(op.clone(), Some(&anchor()), 1002).unwrap() == receipt);
        assert_eq!(
            store.apply(op, Some(&different), 1002).err().unwrap(),
            CONFLICT
        );
    }

    #[test]
    fn edit_cancel_and_reorder_keep_original_request_id_and_one_based_positions() {
        let mut store = store();
        let a = enqueue(&mut store, 10, "A");
        let b = enqueue(&mut store, 11, "B");
        let c = enqueue(&mut store, 12, "C");
        mutate(
            &mut store,
            13,
            OperationKind::Edit {
                queue_id: a.queue_id.clone(),
                text: "edited".into(),
            },
        )
        .unwrap();
        assert_eq!(store.entries[0].item.request_id, uid(10));
        mutate(
            &mut store,
            14,
            OperationKind::Reorder {
                queue_id: c.queue_id.clone(),
                before_queue_id: Some(a.queue_id.clone()),
            },
        )
        .unwrap();
        assert_eq!(store.entries[0].item.queue_id, c.queue_id);
        mutate(
            &mut store,
            15,
            OperationKind::Reorder {
                queue_id: c.queue_id.clone(),
                before_queue_id: None,
            },
        )
        .unwrap();
        assert_eq!(store.entries[2].item.queue_id, c.queue_id);
        assert_eq!(
            store
                .entries
                .iter()
                .map(|e| e.item.position)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        mutate(
            &mut store,
            16,
            OperationKind::Cancel {
                queue_id: b.queue_id.clone(),
            },
        )
        .unwrap();
        assert_eq!(store.entries[1].item.state, QueueState::Cancelled);
        assert_eq!(
            mutate(
                &mut store,
                17,
                OperationKind::Reorder {
                    queue_id: a.queue_id,
                    before_queue_id: Some(b.queue_id)
                }
            )
            .err()
            .unwrap(),
            STATE
        );
    }

    #[test]
    fn claim_needs_real_ready_anchor_and_cancelled_items_cannot_start() {
        let mut store = store();
        let receipt = enqueue(&mut store, 10, "task");
        let mut active = anchor();
        active.ready = false;
        assert_eq!(
            store
                .begin_start(&uid(1), store.revision, &active)
                .err()
                .unwrap(),
            STATE
        );
        assert_eq!(store.entries[0].item.state, QueueState::Queued);
        mutate(
            &mut store,
            11,
            OperationKind::Cancel {
                queue_id: receipt.queue_id,
            },
        )
        .unwrap();
        assert!(store.next_ready().is_none());
        assert!(store
            .begin_start(&uid(1), store.revision, &anchor())
            .is_err());
    }

    #[test]
    fn starting_is_immutable_and_late_registered_mapping_survives_context_change() {
        let mut store = store();
        let receipt = enqueue(&mut store, 10, "first");
        enqueue(&mut store, 11, "second");
        let claim = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        assert_eq!(
            mutate(
                &mut store,
                12,
                OperationKind::Cancel {
                    queue_id: receipt.queue_id.clone()
                }
            )
            .err()
            .unwrap(),
            STATE
        );
        assert!(store.next_ready().is_none());
        let mut context = context();
        context.token = uid(4);
        store.set_context(Some(context), true).unwrap();
        let snap = store.registered(&claim, &uid(20)).unwrap();
        assert_eq!(snap.items[0].state, QueueState::Running);
        assert_eq!(
            snap.items[0].native_run_id.as_deref(),
            Some(uid(20).as_str())
        );
        assert_eq!(snap.items[1].state, QueueState::Held);
        let revision = store.revision;
        store.registered(&claim, &uid(20)).unwrap();
        assert_eq!(store.revision, revision);
        assert!(store.registered(&claim, &uid(21)).is_err());
        let mut altered = claim.clone();
        altered.item.text = "changed".into();
        assert!(store.registered(&altered, &uid(22)).is_err());
    }

    #[test]
    fn unknown_start_is_never_editable_or_replayed_but_late_actual_id_is_recorded() {
        let mut store = store();
        let receipt = enqueue(&mut store, 10, "first");
        enqueue(&mut store, 11, "second");
        let claim = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.unknown(&claim).unwrap();
        assert_eq!(store.entries[0].item.state, QueueState::Unknown);
        assert_eq!(store.entries[1].item.state, QueueState::Held);
        assert!(store.next_ready().is_none());
        for kind in [
            OperationKind::Cancel {
                queue_id: receipt.queue_id.clone(),
            },
            OperationKind::Resume {
                queue_id: receipt.queue_id.clone(),
            },
            OperationKind::Edit {
                queue_id: receipt.queue_id,
                text: "retry".into(),
            },
        ] {
            assert_eq!(mutate(&mut store, 12, kind).err().unwrap(), STATE);
        }
        store.registered(&claim, &uid(20)).unwrap();
        assert_eq!(store.entries[0].item.state, QueueState::Running);
        assert_eq!(store.entries[1].item.state, QueueState::Held);
    }

    #[test]
    fn successful_lineage_uses_actual_previous_run_checkpoint_for_the_second_item() {
        let mut store = store();
        enqueue(&mut store, 10, "first");
        enqueue(&mut store, 11, "second");
        store.finish(&uid(2), QueueState::Done, true).unwrap();
        let first = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.registered(&first, &uid(20)).unwrap();
        store.finish(&uid(20), QueueState::Done, true).unwrap();
        let next = store.next_ready().unwrap();
        assert_eq!(next.anchor_run_id, uid(20));
        let mut completed = anchor();
        completed.run_id = uid(20);
        let second = store
            .begin_start(&uid(1), store.revision, &completed)
            .unwrap();
        assert_eq!(second.item.text, "second");
        assert_eq!(second.item.anchor_run_id, uid(20));
    }

    #[test]
    fn initial_anchor_failure_cancel_or_missing_checkpoint_holds_following_items() {
        for (phase, continuation) in [
            (QueueState::Failed, true),
            (QueueState::Cancelled, true),
            (QueueState::Done, false),
        ] {
            let mut store = store();
            enqueue(&mut store, 10, "first");
            enqueue(&mut store, 11, "second");
            store.finish(&uid(2), phase, continuation).unwrap();
            assert!(store
                .entries
                .iter()
                .all(|e| e.item.state == QueueState::Held));
            assert!(store.next_ready().is_none());
        }
        let mut store = store();
        enqueue(&mut store, 10, "first");
        enqueue(&mut store, 11, "second");
        let first = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.registered(&first, &uid(20)).unwrap();
        store.finish(&uid(20), QueueState::Failed, false).unwrap();
        assert_eq!(store.entries[0].item.state, QueueState::Failed);
        assert_eq!(store.entries[1].item.state, QueueState::Held);
    }

    #[test]
    fn ledger_is_bounded_and_context_rollover_prunes_only_known_terminal_records() {
        let mut store = store();
        let first = enqueue(&mut store, 10, "unknown");
        let claim = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.unknown(&claim).unwrap();
        for n in 11..=25 {
            let r = enqueue(&mut store, n, "cancel");
            mutate(
                &mut store,
                n + 100,
                OperationKind::Cancel {
                    queue_id: r.queue_id,
                },
            )
            .unwrap();
        }
        let id = enqueue(&mut store, 26, "held").queue_id;
        assert_eq!(store.ledger.len(), 32);
        let revision = store.revision;
        assert_eq!(
            mutate(
                &mut store,
                27,
                OperationKind::Edit {
                    queue_id: id,
                    text: "edit".into()
                }
            )
            .err()
            .unwrap(),
            LIMIT
        );
        assert_eq!(store.revision, revision);
        let mut context = context();
        context.token = uid(4);
        store.set_context(Some(context), true).unwrap();
        assert_eq!(store.entries.len(), 2);
        assert!(store
            .entries
            .iter()
            .any(|e| e.item.queue_id == first.queue_id && e.item.state == QueueState::Unknown));
        assert_eq!(store.ledger.len(), 2);
        assert!(store.next_ready().is_none());
    }

    #[test]
    fn revision_exhaustion_blocks_new_mutations_but_never_loses_actual_started_run() {
        let mut store = store();
        enqueue(&mut store, 10, "first");
        enqueue(&mut store, 11, "second");
        store.revision = MAX_SAFE - 1;
        let claim = store.begin_start(&uid(1), MAX_SAFE - 1, &anchor()).unwrap();
        assert_eq!(store.revision, MAX_SAFE);
        let snapshot = store.registered(&claim, &uid(20)).unwrap();
        assert_eq!(snapshot.revision, MAX_SAFE);
        assert!(!snapshot.available);
        assert_eq!(snapshot.items[0].state, QueueState::Running);
        assert_eq!(snapshot.items[1].state, QueueState::Held);
        store.finish(&uid(20), QueueState::Done, true).unwrap();
        assert_eq!(store.entries[0].item.state, QueueState::Done);
        assert!(store.next_ready().is_none());
        assert!(mutate(
            &mut store,
            12,
            OperationKind::Enqueue { text: "new".into() }
        )
        .is_err());
    }

    #[test]
    fn pre_spawn_failure_holds_and_clears_claim_until_explicit_resume_without_forgetting_enqueue() {
        let mut store = store();
        let first = enqueue(&mut store, 10, "first");
        enqueue(&mut store, 11, "second");
        let claim = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.not_started(&claim).unwrap();
        assert!(store
            .entries
            .iter()
            .all(|e| e.item.state == QueueState::Held));
        assert!(store.entries[0].claim.is_none());
        assert!(store.next_ready().is_none());
        let original = Operation {
            context: uid(1),
            request_id: uid(10),
            expected_revision: 0,
            kind: OperationKind::Enqueue {
                text: "first".into(),
            },
        };
        assert!(store.apply(original, Some(&anchor()), 2000).unwrap() == first);
        assert_eq!(store.entries.len(), 2);
        assert!(store.registered(&claim, &uid(20)).is_err());
        mutate(
            &mut store,
            12,
            OperationKind::Resume {
                queue_id: first.queue_id,
            },
        )
        .unwrap();
        let retry = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.registered(&retry, &uid(20)).unwrap();
        let revision = store.revision;
        store.not_started(&retry).unwrap();
        assert_eq!(store.revision, revision);
        assert_eq!(store.entries[0].item.state, QueueState::Running);
    }

    #[test]
    fn item_and_claim_trim_like_native_launch_while_ledger_keeps_original_payload() {
        let mut store = store();
        let op = operation(
            &store,
            10,
            OperationKind::Enqueue {
                text: " \t task \r\n".into(),
            },
        );
        let receipt = store.apply(op.clone(), Some(&anchor()), 1000).unwrap();
        assert_eq!(store.entries[0].item.text, "task");
        let claim = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        assert_eq!(claim.item.text, "task");
        assert!(store.apply(op, Some(&anchor()), 2000).unwrap() == receipt);
        let changed = operation(
            &store,
            10,
            OperationKind::Enqueue {
                text: "task".into(),
            },
        );
        assert_eq!(
            store.apply(changed, Some(&anchor()), 2000).err().unwrap(),
            CONFLICT
        );
    }

    #[test]
    fn new_enqueue_from_original_source_uses_running_execution_leaf_and_retry_keeps_raw_identity() {
        let mut store = store();
        enqueue(&mut store, 10, "first");
        let first = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.registered(&first, &uid(20)).unwrap();
        store.finish(&uid(20), QueueState::Done, true).unwrap();
        let mut resolved = anchor();
        resolved.requested_run_id = Some(uid(2));
        resolved.run_id = store.execution_anchor(&uid(2)).unwrap();
        assert_eq!(resolved.run_id, uid(20));
        let second_op = operation(
            &store,
            11,
            OperationKind::Enqueue {
                text: "second".into(),
            },
        );
        let receipt = store
            .apply(second_op.clone(), Some(&resolved), 1001)
            .unwrap();
        let second = store
            .begin_start(&uid(1), store.revision, &resolved)
            .unwrap();
        store.registered(&second, &uid(21)).unwrap();
        resolved.run_id = store.execution_anchor(&uid(2)).unwrap();
        resolved.ready = false;
        assert_eq!(resolved.run_id, uid(21));
        assert!(store.apply(second_op, Some(&resolved), 1002).unwrap() == receipt);
        let op = operation(
            &store,
            12,
            OperationKind::Enqueue {
                text: "third".into(),
            },
        );
        store.apply(op, Some(&resolved), 1002).unwrap();
        assert_eq!(store.entries[2].item.anchor_run_id, uid(21));
        assert_eq!(store.entries[2].item.request_id, uid(12));
    }

    #[test]
    fn execution_anchor_rejects_ambiguous_branches_cycles_and_foreign_contexts() {
        let mut store = store();
        enqueue(&mut store, 10, "first");
        let first = store
            .begin_start(&uid(1), store.revision, &anchor())
            .unwrap();
        store.registered(&first, &uid(20)).unwrap();
        store.finish(&uid(20), QueueState::Done, true).unwrap();
        let mut second_anchor = anchor();
        second_anchor.run_id = uid(20);
        let op = operation(
            &store,
            11,
            OperationKind::Enqueue {
                text: "second".into(),
            },
        );
        store.apply(op, Some(&second_anchor), 1001).unwrap();
        let second = store
            .begin_start(&uid(1), store.revision, &second_anchor)
            .unwrap();
        store.registered(&second, &uid(21)).unwrap();
        store.entries[1].item.anchor_run_id = uid(2);
        assert_eq!(store.execution_anchor(&uid(2)).err().unwrap(), STATE);
        store.entries[1].item.anchor_run_id = uid(20);
        store.entries[1].item.native_run_id = Some(uid(2));
        assert_eq!(store.execution_anchor(&uid(2)).err().unwrap(), STATE);
        store.entries[1].item.native_run_id = Some(uid(21));
        store.entries[1].context = uid(99);
        assert_eq!(store.execution_anchor(&uid(2)).err().unwrap(), CONTEXT);
        assert_eq!(store.execution_anchor(&uid(21)).err().unwrap(), CONTEXT);
        assert_eq!(store.execution_anchor("invalid").err().unwrap(), INVALID);
        assert_eq!(store.execution_anchor(&uid(88)).unwrap(), uid(88));
    }

    #[test]
    fn execution_anchor_traverses_at_most_32_registered_steps() {
        let mut store = store();
        enqueue(&mut store, 10, "template");
        let item = store.entries[0].item.clone();
        store.entries.clear();
        for n in 0..32 {
            let mut edge = item.clone();
            edge.anchor_run_id = uid(100 + n);
            edge.native_run_id = Some(uid(101 + n));
            edge.queue_id = uid(200 + n);
            edge.state = QueueState::Done;
            store.entries.push(Entry {
                context: uid(1),
                item: edge,
                claim: None,
            });
        }
        assert_eq!(store.execution_anchor(&uid(100)).unwrap(), uid(132));
        let mut edge = item;
        edge.anchor_run_id = uid(132);
        edge.native_run_id = Some(uid(133));
        store.entries.push(Entry {
            context: uid(1),
            item: edge,
            claim: None,
        });
        assert_eq!(store.execution_anchor(&uid(100)).err().unwrap(), STATE);
    }
}
