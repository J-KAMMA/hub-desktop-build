//! Opt-in real CLI acceptance. The oracle is compiled into this test binary,
//! outside the writable fixture; no operator project or settings are changed.
use super::*;
use serde_json::json;
use std::time::Duration;

struct Case {
    name: &'static str,
    path: &'static str,
    broken: &'static str,
    corrected: &'static str,
    request: &'static str,
    oracle: &'static str,
}

const MEAN: Case = Case {
    name: "mean",
    path: "src/metrics.cjs",
    broken: "exports.mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length - 1);\n",
    corrected: "exports.mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;\n",
    request: "Fix src/metrics.cjs. For an empty array mean must return null. For nonempty finite numbers return the arithmetic mean, including one value and negative values. Preserve the CommonJS export.",
    oracle: "const a=require('node:assert/strict');const{mean}=require('./src/metrics.cjs');for(const [input,want] of [[[],null],[[7],7],[[-2,4],1],[[0,0],0],[[1,2,6],3],[[.5,1.5],1]])a.equal(mean(input),want);",
};

const LINES: Case = Case {
    name: "lines",
    path: "src/lines.cjs",
    broken: "exports.uniqueLines = text => text.split('\\n');\n",
    corrected: "exports.uniqueLines = text => [...new Set(text.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean))];\n",
    request: "Fix src/lines.cjs. uniqueLines must accept text with LF or CRLF lines, trim whitespace around each line, remove empty lines, and return unique lines in their first-occurrence order. Case is significant. Preserve Unicode and the CommonJS export.",
    oracle: r#"const a=require('node:assert/strict');const{uniqueLines}=require('./src/lines.cjs');for(const[input,want]of[["",[]],["a",["a"]],["a\na\nb",["a","b"]],[" a \r\nb\r\n a ",["a","b"]],[" \n\t\n",[]],["日\n日\nA\na",["日","A","a"]]])a.deepEqual(uniqueLines(input),want);"#,
};

fn fixture(case: &Case) -> (CliTemporaryDirectory, PathBuf) {
    let directory = CliTemporaryDirectory::create().unwrap();
    let workspace = directory.0.join("workspace");
    std::fs::create_dir_all(workspace.join("src")).unwrap();
    let workspace = workspace.canonicalize().unwrap();
    std::fs::write(workspace.join(case.path), case.broken).unwrap();
    std::fs::write(workspace.join("verify.cjs"), case.oracle).unwrap();
    assert!(crate::local_cli::quiet_std_command("git")
        .arg("init")
        .current_dir(&workspace)
        .output()
        .unwrap()
        .status
        .success());
    (directory, workspace)
}

async fn reference(case: &Case, workspace: &std::path::Path) -> serde_json::Value {
    // Bound even a broken implementation that loops or floods stdout.
    crate::agent_exec::ExecRequest::parse(json!({
        "program": "node", "args": ["-e", case.oracle], "timeoutMs": 10000,
    }))
    .unwrap()
    .run(workspace)
    .await
    .unwrap()
}

#[tokio::test]
async fn acceptance_oracles_reject_broken_code_and_do_not_trust_editable_checks() {
    for case in [&MEAN, &LINES] {
        let (_directory, workspace) = fixture(case);
        assert_ne!(reference(case, &workspace).await["exitCode"], 0);
        std::fs::write(workspace.join("verify.cjs"), "process.exit(0)").unwrap();
        assert_ne!(reference(case, &workspace).await["exitCode"], 0);
        std::fs::write(workspace.join(case.path), case.corrected).unwrap();
        let result = reference(case, &workspace).await;
        assert_eq!(result["exitCode"], 0, "{}: {result}", case.name);
        assert_eq!(result["timedOut"], false);
    }
}

#[tokio::test]
#[ignore = "requires explicit authorization: real Codex inference using the existing login and account usage"]
async fn installed_codex_repairs_mean_with_required_verification() {
    real_cli_acceptance("codex", &MEAN).await;
}

#[tokio::test]
#[ignore = "requires explicit authorization: real Codex inference using the existing login and account usage"]
async fn installed_codex_repairs_lines_with_required_verification() {
    real_cli_acceptance("codex", &LINES).await;
}

#[tokio::test]
#[ignore = "requires explicit authorization and login: real Claude Code inference using account usage"]
async fn installed_claude_repairs_mean_with_required_verification() {
    real_cli_acceptance("claude", &MEAN).await;
}

#[tokio::test]
#[ignore = "requires explicit authorization and login: real Claude Code inference using account usage"]
async fn installed_claude_repairs_lines_with_required_verification() {
    real_cli_acceptance("claude", &LINES).await;
}

async fn real_cli_acceptance(agent: &str, case: &Case) {
    // An invocation guard, not a substitute for the operator's authorization.
    let permission = match agent {
        "codex" => "HUB_CODEX_ACCEPTANCE",
        "claude" => "HUB_CLAUDE_ACCEPTANCE",
        _ => panic!("unreviewed acceptance adapter"),
    };
    assert_eq!(std::env::var(permission).as_deref(), Ok("approved"));
    let _env = crate::local_cli::ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    assert_eq!(
        authentication(agent).await.unwrap().state,
        crate::cli_auth::AuthState::Configured,
        "the operator must authenticate this CLI before running the acceptance test"
    );
    let (_directory, workspace) = fixture(case);
    let spec = builtin_specs()
        .into_iter()
        .find(|spec| spec.id == agent)
        .unwrap();
    // Do not accidentally execute an operator's replacement adapter.
    assert!(
        serde_json::to_value(spec_for(agent).unwrap()).unwrap()
            == serde_json::to_value(&spec).unwrap(),
        "CLI adapter differs from the reviewed built-in"
    );
    let command: crate::verification::VerificationCommand = serde_json::from_value(json!({
        "program": "node", "args": ["verify.cjs"], "timeoutMs": 10000,
    }))
    .unwrap();
    let state = Arc::new(Mutex::new(DevRuns::default()));
    let owner = "cli-acceptance";
    let check_instruction = if spec.file_tools_only {
        "Shell is unavailable. Hub will independently run node verify.cjs after you finish; do not claim to have run it."
    } else {
        "Run node verify.cjs and fix any failure."
    };
    let id = DevRuns::request_approval(&state, DevRequest {
        agent: agent.into(),
        prompt: format!("{} Read before editing and read back the change. Add no dependencies. {check_instruction} Do not change verify.cjs. Work only in this synthetic fixture; do not delegate, commit, publish, or change settings. Report the changed file and verification result.", case.request),
        model: Some(spec.default_model.clone()),
        effort: Some("medium".into()),
        resume: None,
        idempotency_key: Some(uuid::Uuid::new_v4().to_string()),
        verification: Some(command.clone()),
    }, workspace.clone(), owner.into()).await.unwrap();
    assert!(DevRuns::get(&state, &id).await.is_none());
    assert_eq!(
        std::fs::read_to_string(workspace.join(case.path)).unwrap(),
        case.broken
    );
    DevRuns::approve_for(&state, &id, owner).await.unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(450);
    let mut approvals = 0;
    let mut cancelled = false;
    let finished = loop {
        let run = DevRuns::get(&state, &id).await.unwrap();
        if matches!(run.status, "done" | "failed" | "cancelled") {
            break run;
        }
        if !cancelled && tokio::time::Instant::now() >= deadline {
            DevRuns::cancel_for(&state, &id, owner).await.unwrap();
            cancelled = true;
        } else if !cancelled {
            if let Some(action) = run.pending_verification {
                let approved = approvals == 0
                    && action.command.value() == command.value()
                    && std::fs::read_to_string(workspace.join("verify.cjs"))
                        .ok()
                        .as_deref()
                        == Some(case.oracle);
                DevRuns::decide_verification_for(&state, &id, &action.id, owner, approved)
                    .await
                    .unwrap();
                approvals += usize::from(approved);
            }
        }
        // Preserve the fixture for inspection if cancellation itself fails.
        if tokio::time::Instant::now() > deadline + Duration::from_secs(30) {
            std::mem::forget(_directory);
            panic!("owned acceptance run did not stop: {id}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let result = reference(case, &workspace).await;
    println!(
        "CLI acceptance: {}",
        json!({
            "task": case.name, "agent": agent, "model": finished.model, "status": finished.status,
            "elapsedMs": now_ms().unwrap().saturating_sub(finished.started_at_ms),
            "toolCalls": finished.tool_calls, "usage": finished.usage,
            "verification": finished.verification, "stopReason": finished.stop_reason,
            "independentExitCode": result["exitCode"], "independentTimedOut": result["timedOut"],
        })
    );
    assert_eq!(finished.status, "done");
    assert_eq!(finished.verification.unwrap().status, "passed");
    assert_eq!(approvals, 1);
    assert_eq!(
        std::fs::read_to_string(workspace.join("verify.cjs")).unwrap(),
        case.oracle
    );
    assert_eq!(result["exitCode"], 0, "independent reference: {result}");
    assert_eq!(result["timedOut"], false);
    assert_ne!(
        std::fs::read_to_string(workspace.join(case.path)).unwrap(),
        case.broken
    );
    assert!(finished.harness.evaluation.completion_gate_passed);
}
