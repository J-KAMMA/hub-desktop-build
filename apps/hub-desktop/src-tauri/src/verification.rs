//! A required command is operator input, never a model's completion claim.
//! Keep its arguments out of plaintext run metadata. The operator declaring
//! the command for a run is the approval for running exactly that argv, up to
//! `MAX_AUTO_ROUNDS` times; anything else still parks on a normal decision.
use crate::{
    agent_exec::ExecRequest,
    pi_sidecar::{PiApprovalRequest, PiApprover, PiDecision, ToolExecutor},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};

/// Automatic (approval-free) executions of the declared command per run.
pub const MAX_AUTO_ROUNDS: u32 = 5;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationCommand {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cwd: String,
    pub timeout_ms: Option<u64>,
}

impl VerificationCommand {
    pub fn validate(&self) -> Result<(), String> {
        if self.value().to_string().len() > 16 * 1024 {
            return Err("verification_too_large".into());
        }
        ExecRequest::parse(self.value()).map(|_| ())
    }

    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("verification command contains only serializable values")
    }

    fn matches(&self, args: &Value) -> bool {
        let (Ok(expected), Ok(actual)) = (ExecRequest::parse(self.value()), ExecRequest::parse(args.clone())) else {
            return false;
        };
        actual.program == expected.program && actual.args == expected.args
            && actual.cwd == expected.cwd && actual.timeout == expected.timeout && actual.stdin.is_none()
    }

    /// The executor's parsed approval detail for `hub_exec`, compared field by
    /// field. Any stdin, other kind or unparseable detail never matches.
    fn matches_detail(&self, detail: &Value) -> bool {
        if detail["kind"] != "exec" || !detail["stdin"].is_null() {
            return false;
        }
        let cwd = detail["cwd"].as_str().filter(|cwd| !cwd.is_empty());
        self.matches(&serde_json::json!({
            "program": detail["program"], "args": detail["args"], "cwd": cwd, "timeoutMs": detail["timeoutMs"],
        }))
    }
}

/// Approves the declared verification command without parking it, at most
/// `MAX_AUTO_ROUNDS` times; every other request (and any round past the cap)
/// goes to the operator exactly as before. Execution still runs through the
/// normal `hub_exec` path: argv only, workspace cwd, the same limits.
pub fn declared_approver(approver: PiApprover, command: VerificationCommand) -> PiApprover {
    let used = Arc::new(AtomicU32::new(0));
    Arc::new(move |request: PiApprovalRequest| {
        let automatic = request.tool == "hub_exec"
            && command.matches_detail(&request.detail)
            && used
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| (count < MAX_AUTO_ROUNDS).then_some(count + 1))
                .is_ok();
        if automatic {
            return Box::pin(async { PiDecision { approved: true, outcome: None } });
        }
        approver(request)
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationState {
    pub status: String,
    pub attempts: u32,
    /// Automatic rounds allowed for a Pi run, shown with `attempts` as
    /// progress. CLI runs (one approved check) and old records carry none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

impl Default for VerificationState {
    fn default() -> Self { Self { status: "pending".into(), attempts: 0, limit: Some(MAX_AUTO_ROUNDS) } }
}

/// Serialize calls when verification is required: a check must not race a
/// mutation. Any later possibly mutating call invalidates the previous pass.
pub fn gate(
    executor: Arc<dyn ToolExecutor>,
    command: VerificationCommand,
    report: Arc<dyn Fn(VerificationState) + Send + Sync>,
) -> Arc<dyn ToolExecutor> {
    let state = Arc::new(tokio::sync::Mutex::new(VerificationState::default()));
    Arc::new(move |name: String, args: Value| {
        let (executor, command, state, report) = (executor.clone(), command.clone(), state.clone(), report.clone());
        async move {
            let mut state = state.lock().await;
            let check = name == "hub_exec" && command.matches(&args);
            if check && state.status == "denied" { return Err("approval_denied".into()); }
            if check {
                state.status = "running".into();
                state.attempts = state.attempts.saturating_add(1);
                report(state.clone());
            } else if matches!(name.as_str(), "hub_write" | "hub_edit" | "hub_exec" | "hub_test") && state.status != "denied" {
                state.status = "pending".into();
                report(state.clone());
            }
            let result = executor.execute(name, args).await;
            if check {
                state.status = match &result {
                    Ok(answer) if answer.details["exitCode"].as_i64() == Some(0)
                        && answer.details["timedOut"].as_bool() == Some(false) => "passed",
                    Err(error) if error == "approval_denied" => "denied",
                    _ => "failed",
                }.into();
                report(state.clone());
            }
            result
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi_sidecar::ToolAnswer;
    use serde_json::json;
    use std::sync::Mutex;

    fn command() -> VerificationCommand {
        serde_json::from_value(json!({"program":"node","args":["verify.cjs"]})).unwrap()
    }

    #[test]
    fn validates_bounds_and_compares_the_full_execution() {
        let command = command();
        command.validate().unwrap();
        assert!(command.matches(&json!({"program":"node","args":["verify.cjs"],"summary":"ignored"})));
        for altered in [json!({"program":"node","args":["other.cjs"]}), json!({"program":"node","args":["verify.cjs"],"stdin":"payload"}), json!({"program":"node","args":["verify.cjs"],"cwd":"src"}), json!({"program":"node","args":["verify.cjs"],"timeoutMs":1})] {
            assert!(!command.matches(&altered));
        }
        for value in [json!({"program":""}), json!({"program":"node","cwd":".."}), json!({"program":"node","args":["a".repeat(8193)]}), json!({"program":"node","args":vec!["x";65]}), json!({"program":"node","timeoutMs":0}), json!({"program":"node","timeoutMs":600001})] {
            assert!(serde_json::from_value::<VerificationCommand>(value).unwrap().validate().is_err());
        }
        assert!(serde_json::from_value::<VerificationCommand>(json!({"program":"node","stdin":"secret"})).is_err());
        for value in [json!({"program":"x".repeat(260)}), json!({"program":"node","args":vec!["";64],"timeoutMs":600000})] {
            serde_json::from_value::<VerificationCommand>(value).unwrap().validate().unwrap();
        }
        for value in [json!({"program":"x".repeat(261)}), json!({"program":"node","args":["日".repeat(6000)]})] {
            assert!(serde_json::from_value::<VerificationCommand>(value).unwrap().validate().is_err());
        }
    }

    fn counting_approver(asked: Arc<Mutex<Vec<String>>>) -> PiApprover {
        Arc::new(move |request: PiApprovalRequest| {
            asked.lock().unwrap().push(request.tool);
            Box::pin(async { PiDecision { approved: false, outcome: None } })
        })
    }

    fn detail(value: Value) -> Value {
        ExecRequest::parse(value).unwrap().approval_detail()
    }

    #[tokio::test]
    async fn the_declared_command_runs_without_parking_up_to_the_cap() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let approver = declared_approver(counting_approver(asked.clone()), command());
        let exact = PiApprovalRequest { tool: "hub_exec".into(), summary: "node verify.cjs".into(), detail: detail(command().value()) };
        for _ in 0..MAX_AUTO_ROUNDS {
            assert!(approver(exact.clone()).await.approved);
        }
        assert!(asked.lock().unwrap().is_empty());
        // Past the cap the operator decides again, exactly as before.
        assert!(!approver(exact).await.approved);
        assert_eq!(*asked.lock().unwrap(), ["hub_exec"]);
    }

    #[tokio::test]
    async fn anything_but_the_exact_declared_argv_still_asks_the_operator() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let approver = declared_approver(counting_approver(asked.clone()), command());
        let mut requests: Vec<PiApprovalRequest> = [
            json!({"program":"node","args":["verify.cjs","--extra"]}),
            json!({"program":"node","args":["other.cjs"]}),
            json!({"program":"nodejs","args":["verify.cjs"]}),
            json!({"program":"node","args":["verify.cjs"],"stdin":"payload"}),
            json!({"program":"node","args":["verify.cjs"],"cwd":"src"}),
            json!({"program":"node","args":["verify.cjs"],"timeoutMs":1}),
            json!({"program":"node","args":["verify.cjs; rm -rf ."]}),
        ].into_iter().map(|value| PiApprovalRequest { tool: "hub_exec".into(), summary: String::new(), detail: detail(value) }).collect();
        for (tool, detail) in [("hub_http", detail(command().value())), ("hub_write", detail(command().value())), ("hub_exec", json!({"program":"node","args":["verify.cjs"]})), ("hub_exec", json!(null))] {
            requests.push(PiApprovalRequest { tool: tool.into(), summary: String::new(), detail });
        }
        let count = requests.len();
        for request in requests {
            assert!(!approver(request).await.approved);
        }
        assert_eq!(asked.lock().unwrap().len(), count);
    }

    #[test]
    fn progress_carries_the_round_limit_and_old_records_default_it() {
        assert_eq!(VerificationState::default().limit, Some(MAX_AUTO_ROUNDS));
        let old: VerificationState = serde_json::from_value(json!({"status":"passed","attempts":2})).unwrap();
        assert_eq!((old.attempts, old.limit), (2, None));
        assert_eq!(serde_json::to_value(&old).unwrap(), json!({"status":"passed","attempts":2}));
    }

    #[tokio::test]
    async fn only_a_real_exit_zero_passes_and_later_mutations_invalidate_it() {
        let state = Arc::new(Mutex::new(VerificationState::default()));
        let mirror = state.clone();
        let executor: Arc<dyn ToolExecutor> = Arc::new(|_: String, _: Value| async { Ok(ToolAnswer::new(json!([]), json!({"exitCode":0,"timedOut":false}))) });
        let gate = gate(executor, command(), Arc::new(move |next| *mirror.lock().unwrap() = next));
        gate.execute("hub_read".into(), json!({})).await.unwrap();
        assert_eq!(state.lock().unwrap().status, "pending");
        gate.execute("hub_exec".into(), command().value()).await.unwrap();
        assert_eq!(state.lock().unwrap().status, "passed");
        gate.execute("hub_read".into(), json!({})).await.unwrap();
        assert_eq!(state.lock().unwrap().status, "passed");
        gate.execute("hub_edit".into(), json!({})).await.unwrap();
        assert_eq!(state.lock().unwrap().status, "pending");
        gate.execute("hub_exec".into(), command().value()).await.unwrap();
        assert_eq!(state.lock().unwrap().attempts, 2);
        assert_eq!(state.lock().unwrap().status, "passed");
    }

    #[tokio::test]
    async fn missing_exit_status_timeout_and_denial_never_pass() {
        for details in [json!({}), json!({"exitCode":1,"timedOut":false}), json!({"exitCode":0,"timedOut":true})] {
            let state = Arc::new(Mutex::new(VerificationState::default()));
            let mirror = state.clone();
            let executor: Arc<dyn ToolExecutor> = Arc::new(move |_: String, _: Value| { let details = details.clone(); async move { Ok(ToolAnswer::new(json!([]), details)) } });
            gate(executor, command(), Arc::new(move |next| *mirror.lock().unwrap() = next)).execute("hub_exec".into(), command().value()).await.unwrap();
            assert_eq!(state.lock().unwrap().status, "failed");
        }
        let calls = Arc::new(Mutex::new(0));
        let observed = calls.clone();
        let executor: Arc<dyn ToolExecutor> = Arc::new(move |_: String, _: Value| { *observed.lock().unwrap() += 1; async { Err("approval_denied".into()) } });
        let gate = gate(executor, command(), Arc::new(|_| {}));
        for _ in 0..2 { assert_eq!(gate.execute("hub_exec".into(), command().value()).await.unwrap_err(), "approval_denied"); }
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn a_check_waits_for_a_concurrent_mutation() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let (started, released, events) = (entered.clone(), release.clone(), order.clone());
        let executor: Arc<dyn ToolExecutor> = Arc::new(move |name: String, _: Value| {
            let (started, released, events) = (started.clone(), released.clone(), events.clone());
            async move {
                if name == "hub_write" {
                    events.lock().unwrap().push("write-start");
                    started.notify_one();
                    released.notified().await;
                    events.lock().unwrap().push("write-end");
                } else { events.lock().unwrap().push("check"); }
                Ok(ToolAnswer::new(json!([]), json!({"exitCode":0,"timedOut":false})))
            }
        });
        let gate = gate(executor, command(), Arc::new(|_| {}));
        let write = tokio::spawn(gate.execute("hub_write".into(), json!({})));
        entered.notified().await;
        let check = tokio::spawn(gate.execute("hub_exec".into(), command().value()));
        tokio::task::yield_now().await;
        release.notify_one();
        write.await.unwrap().unwrap();
        check.await.unwrap().unwrap();
        assert_eq!(*order.lock().unwrap(), ["write-start", "write-end", "check"]);
    }
}
