use serde::{Deserialize, Serialize};

const MAX_TRACE_EVENTS: usize = 240;
const MAX_OBSERVATIONS: usize = 80;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPermissions {
    pub filesystem: String,
    pub shell: bool,
    pub network: bool,
    pub git_commit: bool,
    pub git_push: bool,
    pub deploy: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContract {
    pub id: String,
    pub objective: String,
    pub workspace: String,
    pub constraints: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub permissions: TaskPermissions,
}

impl TaskContract {
    pub fn development(id: &str, objective: &str, workspace: &str) -> Self {
        Self {
            id: format!("task-{id}"),
            objective: objective.to_owned(),
            workspace: workspace.to_owned(),
            constraints: vec![
                "Change only the selected Git workspace".into(),
                "Do not commit, push, publish, deploy, purchase, or send messages".into(),
                "Do not expose credentials or secret values".into(),
            ],
            acceptance_criteria: vec![
                "Agent process exits successfully".into(),
                "Workspace verification checks pass".into(),
                "No unresolved Git conflicts remain".into(),
            ],
            permissions: TaskPermissions {
                filesystem: "workspace_write".into(),
                shell: true,
                network: false,
                git_commit: false,
                git_push: false,
                deploy: false,
            },
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub description: String,
    pub dependencies: Vec<String>,
    pub status: String,
}

fn default_plan() -> Vec<PlanStep> {
    [
        (
            "inspect",
            "Inspect the workspace and relevant instructions",
            vec![],
        ),
        (
            "implement",
            "Implement the requested change",
            vec!["inspect"],
        ),
        (
            "verify",
            "Run deterministic verification",
            vec!["implement"],
        ),
        (
            "report",
            "Report changes and remaining risks",
            vec!["verify"],
        ),
    ]
    .into_iter()
    .map(|(id, description, dependencies)| PlanStep {
        id: id.into(),
        description: description.into(),
        dependencies: dependencies.into_iter().map(str::to_owned).collect(),
        status: "pending".into(),
    })
    .collect()
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub kind: String,
    pub summary: String,
    pub trust: String,
    pub at_ms: u128,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvent {
    pub sequence: u64,
    pub kind: String,
    pub phase: String,
    pub detail: String,
    pub at_ms: u128,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub risk: String,
    pub timeout_ms: u64,
    pub enforcement: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalReceipt {
    pub id: String,
    pub state: String,
    pub risk_level: String,
    pub requested_capabilities: Vec<String>,
    pub blocked_capabilities: Vec<String>,
    pub request_fingerprint: String,
    pub requested_at_ms: u128,
    pub decided_at_ms: Option<u128>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvaluation {
    pub completion_gate_passed: bool,
    pub recovery_available: bool,
    pub approval_audited: bool,
    pub context_compacted: bool,
    pub policy_violations: u32,
    pub passed_checks: u32,
    pub failed_checks: u32,
    pub score: u8,
}

fn provider_tool_registry() -> Vec<ToolDescriptor> {
    [
        ("filesystem_read", "read", 30_000, "workspace sandbox"),
        (
            "workspace_edit",
            "local_write",
            120_000,
            "workspace sandbox and Git receipt",
        ),
        (
            "shell_command",
            "local_write",
            600_000,
            "workspace sandbox and process budget",
        ),
        ("git_inspect", "read", 30_000, "workspace boundary"),
        ("verification", "read", 600_000, "harness completion gate"),
    ]
    .into_iter()
    .map(|(name, risk, timeout_ms, enforcement)| ToolDescriptor {
        name: name.into(),
        risk: risk.into(),
        timeout_ms,
        enforcement: enforcement.into(),
    })
    .collect()
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub run_id: String,
    pub task_id: String,
    pub status: String,
    pub phase: String,
    pub plan: Vec<PlanStep>,
    pub active_step_id: Option<String>,
    pub observations: Vec<Observation>,
    pub changed_files: Vec<String>,
    pub errors: Vec<String>,
    pub tool_call_count: u32,
    pub model_turn_count: u32,
    pub checkpoint_id: String,
    pub force_replan: bool,
    pub started_at_ms: u128,
    pub updated_at_ms: u128,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessControl {
    pub contract: TaskContract,
    pub state: RunState,
    pub trace: Vec<TraceEvent>,
    pub tool_registry: Vec<ToolDescriptor>,
    #[serde(default)]
    pub adapter: crate::harness_adapter::HarnessAdapterContract,
    pub failure_class: Option<String>,
    #[serde(default)]
    pub context: crate::harness_context::ContextSummary,
    #[serde(default)]
    pub approval: ApprovalReceipt,
    #[serde(default)]
    pub evaluation: RunEvaluation,
    #[serde(default)]
    last_failure_fingerprint: Option<String>,
    #[serde(default)]
    same_failure_count: u8,
}

impl HarnessControl {
    pub fn new(run_id: &str, objective: &str, workspace: &str, now_ms: u128) -> Self {
        let contract = TaskContract::development(run_id, objective, workspace);
        let mut control = Self {
            state: RunState {
                run_id: run_id.into(),
                task_id: contract.id.clone(),
                status: "preparing".into(),
                phase: "planning".into(),
                plan: default_plan(),
                active_step_id: Some("inspect".into()),
                checkpoint_id: format!("{run_id}-0"),
                started_at_ms: now_ms,
                updated_at_ms: now_ms,
                ..Default::default()
            },
            contract,
            tool_registry: provider_tool_registry(),
            ..Default::default()
        };
        control.event("task_started", "Task contract accepted", now_ms);
        control.transition("running", "planning", Some("inspect"), now_ms);
        control
    }

    pub fn configure(
        &mut self,
        adapter: crate::harness_adapter::HarnessAdapterContract,
        context: crate::harness_context::ContextSummary,
        approval: ApprovalReceipt,
        recovery_available: bool,
        now_ms: u128,
    ) {
        self.adapter = adapter;
        self.tool_registry.retain(|tool| match tool.name.as_str() {
            "shell_command" | "git_inspect" => self.contract.permissions.shell,
            "workspace_edit" => self.contract.permissions.filesystem == "workspace_write",
            "filesystem_read" => self.contract.permissions.filesystem != "none",
            _ => true,
        });
        self.context = context;
        self.approval = approval;
        self.evaluation.recovery_available = recovery_available;
        self.event(
            "adapter_connected",
            &format!("{}:{}", self.adapter.id, self.adapter.connection_state),
            now_ms,
        );
        self.event(
            "context_built",
            &format!(
                "{} chars",
                self.context.hot_chars + self.context.warm_chars + self.context.cold_chars
            ),
            now_ms,
        );
        self.event(
            "approval_recorded",
            &self.approval.risk_level.clone(),
            now_ms,
        );
    }

    pub fn transition(&mut self, status: &str, phase: &str, step: Option<&str>, now_ms: u128) {
        self.state.status = status.into();
        self.state.phase = phase.into();
        self.state.active_step_id = step.map(str::to_owned);
        for item in &mut self.state.plan {
            if Some(item.id.as_str()) == step {
                item.status = "running".into();
            } else if item.status == "running" {
                item.status = "completed".into();
            }
        }
        self.event("state_transition", &format!("{status}:{phase}"), now_ms);
    }

    pub fn record_provider_line(&mut self, line: &str, now_ms: u128) -> (u32, u32) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return (0, 0);
        };
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let item_type = value
            .pointer("/item/type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut tools = 0;
        let mut turns = 0;
        if let Some(error) = value.get("error").and_then(|item| {
            item.as_str()
                .or_else(|| item.get("message").and_then(|message| message.as_str()))
        }) {
            self.record_failure(error, now_ms);
            self.observe("error", error, "provider", now_ms);
        }
        if event_type == "item.started"
            && matches!(
                item_type,
                "command_execution" | "file_change" | "mcp_tool_call"
            )
        {
            tools = 1;
            self.event("tool_started", item_type, now_ms);
            self.observe("tool", item_type, "provider", now_ms);
            if self.state.phase == "planning" {
                self.transition("running", "executing", Some("implement"), now_ms);
            }
            if let Some(reason) = prohibited_provider_action(&value) {
                self.evaluation.policy_violations =
                    self.evaluation.policy_violations.saturating_add(1);
                self.event("policy_violation", reason, now_ms);
                self.record_failure(reason, now_ms);
            }
        } else if event_type == "item.completed" {
            if item_type == "agent_message" {
                turns = 1;
                self.event("model_turn_completed", item_type, now_ms);
            } else if !item_type.is_empty() {
                self.event("tool_completed", item_type, now_ms);
            }
        } else if event_type == "assistant" {
            turns = 1;
            let tool_uses = value
                .pointer("/message/content")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter(|item| {
                            item.get("type").and_then(|v| v.as_str()) == Some("tool_use")
                        })
                        .count() as u32
                })
                .unwrap_or(0);
            tools = tool_uses;
            self.event("model_turn_completed", "assistant", now_ms);
            for _ in 0..tool_uses {
                self.event("tool_started", "provider_tool", now_ms);
            }
        } else if event_type == "result" {
            self.event(
                "provider_result",
                "Provider returned a terminal result",
                now_ms,
            );
        } else if event_type == "agent_start" {
            // pi --mode json: 実行開始。--no-tools では tool イベントが
            // 来ないので、ここで実行段階へ進めないと planning のまま終わる。
            if self.state.phase == "planning" {
                self.transition("running", "executing", Some("implement"), now_ms);
            }
            self.event("provider_started", "agent_start", now_ms);
        } else if event_type == "tool_execution_start" {
            // pi: {toolCallId, toolName, args}。実行系はHub側の権限層が
            // 担うので、ここでは観測と計数だけを行う。
            let name = value
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("provider_tool");
            tools = 1;
            self.event("tool_started", name, now_ms);
            self.observe("tool", name, "provider", now_ms);
            if self.state.phase == "planning" {
                self.transition("running", "executing", Some("implement"), now_ms);
            }
        } else if event_type == "tool_execution_end" {
            let name = value
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("provider_tool");
            if value.get("isError").and_then(|v| v.as_bool()) == Some(true) {
                self.record_failure(&format!("{name} failed"), now_ms);
                self.observe("error", name, "provider", now_ms);
            }
            self.event("tool_completed", name, now_ms);
        } else if event_type == "turn_end" {
            turns = 1;
            self.event("model_turn_completed", "turn_end", now_ms);
        } else if event_type == "agent_end" || event_type == "agent_settled" {
            self.event(
                "provider_result",
                "Provider returned a terminal result",
                now_ms,
            );
        }
        self.state.tool_call_count = self.state.tool_call_count.saturating_add(tools);
        self.state.model_turn_count = self.state.model_turn_count.saturating_add(turns);
        self.checkpoint(now_ms);
        (tools, turns)
    }

    pub fn begin_verification(&mut self, now_ms: u128) {
        self.transition("verifying", "verifying", Some("verify"), now_ms);
        self.event(
            "verification_started",
            "Deterministic workspace checks",
            now_ms,
        );
    }

    pub fn finish(
        &mut self,
        passed: bool,
        errors: &[String],
        changed_files: Vec<String>,
        now_ms: u128,
    ) {
        self.state.changed_files = changed_files;
        self.state.errors = errors.to_vec();
        if passed && errors.is_empty() {
            self.transition("completed", "completed", Some("report"), now_ms);
            for item in &mut self.state.plan {
                item.status = "completed".into();
            }
            self.state.active_step_id = None;
            self.event("verification_passed", "Completion gate passed", now_ms);
            self.event("run_completed", "Run completed by harness", now_ms);
        } else {
            self.transition("failed", "failed", None, now_ms);
            self.event("verification_failed", &errors.join("; "), now_ms);
            if let Some(first) = errors.first() {
                self.record_failure(first, now_ms);
            }
        }
        self.evaluation.completion_gate_passed = passed && errors.is_empty();
        self.evaluation.approval_audited = self.approval.state == "approved";
        self.evaluation.context_compacted = self.context.compacted;
        self.evaluation.failed_checks = errors.len() as u32;
        self.evaluation.passed_checks = if passed { 1 } else { 0 };
        let mut score = 100u8;
        if !self.evaluation.completion_gate_passed {
            score = score.saturating_sub(35);
        }
        // Missing recovery only costs a run that could have inflicted damage:
        // a proposal-only adapter never writes, so no git baseline is no gap.
        let can_write = self
            .adapter
            .capabilities
            .iter()
            .any(|cap| cap == "workspace_write");
        if can_write && !self.evaluation.recovery_available {
            score = score.saturating_sub(20);
        }
        if !self.evaluation.approval_audited {
            score = score.saturating_sub(20);
        }
        score = score.saturating_sub((self.evaluation.policy_violations.min(5) * 10) as u8);
        self.evaluation.score = score;
        self.event("evaluation_completed", &format!("score={score}"), now_ms);
        self.checkpoint(now_ms);
    }

    pub fn record_failure(&mut self, message: &str, now_ms: u128) {
        let fingerprint = failure_fingerprint(message);
        if self.last_failure_fingerprint.as_deref() == Some(&fingerprint) {
            self.same_failure_count = self.same_failure_count.saturating_add(1);
        } else {
            self.last_failure_fingerprint = Some(fingerprint);
            self.same_failure_count = 1;
        }
        self.failure_class = Some(classify_failure(message).into());
        self.state.force_replan = self.same_failure_count >= 3;
        let failure_class = self.failure_class.clone().unwrap_or_else(|| "fatal".into());
        self.event("failure_classified", &failure_class, now_ms);
    }

    fn observe(&mut self, kind: &str, summary: &str, trust: &str, now_ms: u128) {
        self.state.observations.push(Observation {
            kind: kind.into(),
            summary: summary.into(),
            trust: trust.into(),
            at_ms: now_ms,
        });
        if self.state.observations.len() > MAX_OBSERVATIONS {
            self.state.observations.remove(0);
        }
    }

    fn event(&mut self, kind: &str, detail: &str, now_ms: u128) {
        let sequence = self
            .trace
            .last()
            .map(|event| event.sequence + 1)
            .unwrap_or(1);
        self.trace.push(TraceEvent {
            sequence,
            kind: kind.into(),
            phase: self.state.phase.clone(),
            detail: detail.chars().take(240).collect(),
            at_ms: now_ms,
        });
        if self.trace.len() > MAX_TRACE_EVENTS {
            self.trace.remove(0);
        }
        self.state.updated_at_ms = now_ms;
    }

    fn checkpoint(&mut self, now_ms: u128) {
        let sequence = self.trace.last().map(|event| event.sequence).unwrap_or(0);
        self.state.checkpoint_id = format!("{}-{sequence}", self.state.run_id);
        self.state.updated_at_ms = now_ms;
    }
}

pub fn approval_preview(prompt: &str, fingerprint: &str, requested_at_ms: u128) -> ApprovalReceipt {
    let lower = prompt.to_lowercase();
    let mut requested = vec![
        "workspace_read".to_owned(),
        "workspace_write".to_owned(),
        "shell".to_owned(),
    ];
    let mut blocked = Vec::new();
    let mut risk = "R1";
    for (needle, capability) in [
        ("deploy", "deploy"),
        ("配備", "deploy"),
        ("publish", "publish"),
        ("公開", "publish"),
        ("push", "git_push"),
        ("commit", "git_commit"),
        ("購入", "purchase"),
        ("send", "external_message"),
        ("送信", "external_message"),
        ("delet", "destructive_delete"),
        ("削除", "destructive_delete"),
    ] {
        if lower.contains(needle) && !requested.iter().any(|item| item == capability) {
            requested.push(capability.into());
        }
    }
    for capability in &requested {
        if matches!(
            capability.as_str(),
            "deploy" | "publish" | "git_push" | "git_commit" | "purchase" | "external_message"
        ) {
            blocked.push(capability.clone());
            risk = "R3";
        } else if capability == "destructive_delete" && risk != "R3" {
            risk = "R2";
        }
    }
    ApprovalReceipt {
        id: format!("approval-{}", &fingerprint[..fingerprint.len().min(16)]),
        state: "awaiting_confirmation".into(),
        risk_level: risk.into(),
        requested_capabilities: requested,
        blocked_capabilities: blocked,
        request_fingerprint: fingerprint.into(),
        requested_at_ms,
        decided_at_ms: None,
    }
}

pub fn prohibited_provider_action(value: &serde_json::Value) -> Option<&'static str> {
    let command = value
        .pointer("/item/command")
        .or_else(|| value.pointer("/item/input/command"))
        .or_else(|| value.pointer("/tool_input/command"))
        .and_then(|item| item.as_str())?
        .to_ascii_lowercase();
    [
        ("git push", "git_push_blocked"),
        ("git commit", "git_commit_blocked"),
        ("wrangler deploy", "deploy_blocked"),
        ("npm publish", "publish_blocked"),
        ("gh release", "publish_blocked"),
        ("npm install", "dependency_change_approval_required"),
        ("npm add", "dependency_change_approval_required"),
        ("pnpm add", "dependency_change_approval_required"),
        ("yarn add", "dependency_change_approval_required"),
        ("cargo add", "dependency_change_approval_required"),
        ("git pull", "network_access_blocked"),
        ("curl ", "network_access_blocked"),
        ("wget ", "network_access_blocked"),
        ("invoke-webrequest", "network_access_blocked"),
        ("rm -rf", "recursive_delete_blocked"),
        ("remove-item -recurse", "recursive_delete_blocked"),
    ]
    .into_iter()
    .find_map(|(needle, reason)| command.contains(needle).then_some(reason))
}

pub fn classify_failure(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("permission") || lower.contains("approval") || lower.contains("denied") {
        "permission"
    } else if lower.contains("timeout")
        || lower.contains("temporar")
        || lower.contains("unreachable")
        || lower.contains("connection reset")
    {
        "transient"
    } else if lower.contains("budget")
        || lower.contains("output_budget")
        || lower.contains("tool_call_budget")
    {
        "budget"
    } else if lower.contains("not found")
        || lower.contains("spawn")
        || lower.contains("environment")
    {
        "environment"
    } else if lower.contains("invalid") || lower.contains("syntax") {
        "tool_input"
    } else if lower.contains("verification")
        || lower.contains("test")
        || lower.contains("typecheck")
    {
        "strategy"
    } else {
        "fatal"
    }
}

fn failure_fingerprint(message: &str) -> String {
    message
        .to_ascii_lowercase()
        .split_whitespace()
        .take(24)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_structured_contract_and_state_machine() {
        let control = HarnessControl::new("run-1", "Fix login", "C:/repo", 10);
        assert_eq!(control.contract.permissions.git_push, false);
        assert_eq!(control.state.phase, "planning");
        assert_eq!(control.state.plan[1].dependencies, vec!["inspect"]);
        assert!(control
            .tool_registry
            .iter()
            .all(|tool| tool.risk == "read" || tool.risk == "local_write"));
        assert!(!control.trace.is_empty());
    }

    #[test]
    fn normalizes_provider_events_and_checkpoints() {
        let mut control = HarnessControl::new("run-1", "Fix login", "C:/repo", 10);
        let metrics = control.record_provider_line(
            r#"{"type":"item.started","item":{"type":"command_execution"}}"#,
            20,
        );
        assert_eq!(metrics, (1, 0));
        assert_eq!(control.state.phase, "executing");
        assert_eq!(control.state.tool_call_count, 1);
        assert_ne!(control.state.checkpoint_id, "run-1-0");

        let claude = control.record_provider_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text"},{"type":"tool_use"}]}}"#,
            30,
        );
        assert_eq!(claude, (1, 1));
    }

    #[test]
    fn normalizes_pi_json_events() {
        // pi --mode json の実出力列（ollama実測）に合わせた形状。
        let mut control = HarnessControl::new("run-1", "Summarize", "C:/repo", 10);
        // session ヘッダは session_from が拾うもので、進捗計数には載らない。
        assert_eq!(
            control.record_provider_line(
                r#"{"type":"session","id":"01a0b425-9de3-772c-86dd-461f9ec4671f"}"#,
                10,
            ),
            (0, 0)
        );
        assert_eq!(
            control.record_provider_line(r#"{"type":"agent_start"}"#, 11),
            (0, 0)
        );
        // --no-tools でも実行段階へ進む。
        assert_eq!(control.state.phase, "executing");
        assert_eq!(
            control.record_provider_line(
                r#"{"type":"tool_execution_start","toolCallId":"call_1","toolName":"hub_read","args":{"path":"a.txt"}}"#,
                12,
            ),
            (1, 0)
        );
        assert_eq!(
            control.record_provider_line(
                r#"{"type":"tool_execution_end","toolCallId":"call_1","toolName":"hub_read","result":{"content":[]},"isError":false}"#,
                13,
            ),
            (0, 0)
        );
        assert_eq!(
            control.record_provider_line(
                r#"{"type":"tool_execution_start","toolCallId":"call_2","toolName":"hub_write","args":{}}"#,
                14,
            ),
            (1, 0)
        );
        assert_eq!(
            control.record_provider_line(
                r#"{"type":"tool_execution_end","toolCallId":"call_2","toolName":"hub_write","result":{"content":[]},"isError":true}"#,
                15,
            ),
            (0, 0)
        );
        // message_start/message_update はストリーミング詳細で計数しない。
        assert_eq!(
            control.record_provider_line(
                r#"{"type":"message_update","usage":{"input":407}}"#,
                16,
            ),
            (0, 0)
        );
        assert_eq!(
            control.record_provider_line(
                r#"{"type":"turn_end","message":{"role":"assistant","content":[]}}"#,
                17,
            ),
            (0, 1)
        );
        assert_eq!(
            control.record_provider_line(r#"{"type":"agent_end","messages":[]}"#, 18),
            (0, 0)
        );
        assert_eq!(control.state.tool_call_count, 2);
        assert_eq!(control.state.model_turn_count, 1);
        // isError の tool_execution_end は失敗として記録される。
        assert_eq!(control.failure_class.as_deref(), Some("fatal"));
        assert!(control
            .trace
            .iter()
            .any(|e| e.kind == "failure_classified" && e.detail == "fatal"));
    }

    #[test]
    fn repeated_failures_force_a_replan() {
        let mut control = HarnessControl::new("run-1", "Fix login", "C:/repo", 10);
        for now in 20..23 {
            control.record_failure("TS2322 typecheck failed", now);
        }
        assert!(control.state.force_replan);
        assert_eq!(control.failure_class.as_deref(), Some("strategy"));
    }

    #[test]
    fn only_completion_gate_marks_completed() {
        let mut control = HarnessControl::new("run-1", "Fix login", "C:/repo", 10);
        control.begin_verification(20);
        control.finish(true, &[], vec!["src/auth.ts".into()], 30);
        assert_eq!(control.state.status, "completed");
        assert!(control
            .trace
            .iter()
            .any(|event| event.kind == "run_completed"));
    }

    #[test]
    fn approval_preview_blocks_external_side_effects() {
        let preview =
            approval_preview("deploy and git push after deleting old files", "abcdef", 10);
        assert_eq!(preview.risk_level, "R3");
        assert!(preview.blocked_capabilities.contains(&"deploy".into()));
        assert!(preview
            .requested_capabilities
            .contains(&"destructive_delete".into()));
    }

    #[test]
    fn provider_policy_detects_prohibited_commands() {
        let value = serde_json::json!({"item":{"command":"git push origin main"}});
        assert_eq!(prohibited_provider_action(&value), Some("git_push_blocked"));
    }
}
