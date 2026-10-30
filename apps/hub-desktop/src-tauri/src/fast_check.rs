//! Fast type/lint feedback on the edit path (owner-approved 2026-10-18).
//!
//! After a successful `hub_write` / `hub_edit`, a recognised checker for the
//! workspace (tsc, cargo check, pyright, mypy, eslint — detected from project
//! files) runs once with a short timeout, and only error lines for files this
//! run changed that were not present before the run's first write are
//! appended to that same tool result. No extra turn is injected.
//!
//! A detected command runs only when the operator allowed exactly that argv for
//! the run (`checkers`) or declared it as the verification command, and only on
//! a run with `allowExec`. Execution goes through the ordinary `hub_exec`
//! machinery (`agent_exec::ExecRequest::run`): argv only, workspace cwd,
//! curated environment, capped output. Detection never proposes a command that
//! fetches packages (`npx`), and `cargo check` runs `--offline`.
use crate::{
    agent_exec::ExecRequest,
    pi_sidecar::{ToolAnswer, ToolExecutor},
    verification::VerificationCommand,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

/// Per-check budget; a slower checker is reported as timed out and skipped.
pub const CHECK_TIMEOUT_MS: u64 = 20_000;
/// Error lines attached to one edit result.
pub const MAX_LINES: usize = 30;
const MAX_LINE_CHARS: usize = 300;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedChecker {
    pub id: String,
    pub command: VerificationCommand,
}

fn command(program: &str, args: &[&str]) -> VerificationCommand {
    VerificationCommand {
        program: program.into(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cwd: String::new(),
        timeout_ms: Some(CHECK_TIMEOUT_MS),
    }
}

fn file_contains(path: &Path, needle: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|text| text.contains(needle))
}

/// Recognised checkers for `root`, most specific first. Only local tool
/// installations are proposed: a missing `node_modules` binary means no tsc
/// or eslint check rather than a download.
pub fn detect(root: &Path) -> Vec<DetectedChecker> {
    let has = |name: &str| root.join(name).is_file();
    let mut found = Vec::new();
    if has("tsconfig.json") && has("node_modules/typescript/bin/tsc") {
        found.push(DetectedChecker {
            id: "tsc".into(),
            command: command("node", &["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json",
                "--pretty", "false", "--incremental", "--tsBuildInfoFile", "node_modules/.cache/hub-fast-check.tsbuildinfo"]),
        });
    }
    if has("Cargo.toml") {
        found.push(DetectedChecker {
            id: "cargo".into(),
            command: command("cargo", &["check", "--offline", "--quiet", "--message-format", "short"]),
        });
    }
    let pyproject = root.join("pyproject.toml");
    if has("pyrightconfig.json") || file_contains(&pyproject, "[tool.pyright]") {
        found.push(DetectedChecker { id: "pyright".into(), command: command("pyright", &[]) });
    }
    if has("mypy.ini") || has(".mypy.ini") || file_contains(&pyproject, "[tool.mypy]")
        || file_contains(&root.join("setup.cfg"), "[mypy]") {
        found.push(DetectedChecker {
            id: "mypy".into(),
            command: command("mypy", &["--no-color-output", "--no-error-summary", "--show-column-numbers", "."]),
        });
    }
    let eslint_config = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc"]
        .iter().any(|name| has(name));
    if eslint_config && has("node_modules/eslint/bin/eslint.js") {
        found.push(DetectedChecker {
            id: "eslint".into(),
            command: command("node", &["node_modules/eslint/bin/eslint.js", "--cache", "--cache-location",
                "node_modules/.cache/hub-fast-check-eslint/", "."]),
        });
    }
    found
}

fn same_argv(left: &VerificationCommand, right: &VerificationCommand) -> bool {
    left.program == right.program && left.args == right.args && left.cwd == right.cwd
}

/// The first detected checker whose argv the operator allowed for this run.
pub fn select(root: &Path, allowed: &[VerificationCommand]) -> Option<DetectedChecker> {
    detect(root).into_iter().find(|checker| allowed.iter().any(|command| same_argv(command, &checker.command)))
}

enum CheckRun {
    Output(String),
    TimedOut,
    Failed(String),
}

async fn run_checker(workspace: &Path, checker: &DetectedChecker) -> CheckRun {
    let mut value = checker.command.value();
    let timeout = checker.command.timeout_ms.unwrap_or(CHECK_TIMEOUT_MS).min(CHECK_TIMEOUT_MS);
    value["timeoutMs"] = json!(timeout);
    let request = match ExecRequest::parse(value) {
        Ok(request) => request,
        Err(error) => return CheckRun::Failed(error),
    };
    match request.run(workspace).await {
        Ok(result) if result["timedOut"].as_bool() == Some(true) => CheckRun::TimedOut,
        Ok(result) => CheckRun::Output(format!(
            "{}\n{}",
            result["stdout"].as_str().unwrap_or_default(),
            result["stderr"].as_str().unwrap_or_default()
        )),
        Err(error) => CheckRun::Failed(error),
    }
}

fn normalize(line: &str) -> String {
    line.replace('\\', "/").to_lowercase()
}

fn is_error(normalized: &str) -> bool {
    normalized.contains("error") && !normalized.contains(" 0 errors") && !normalized.starts_with("found ")
        && !normalized.contains("warning")
}

/// Line-number-free identity of one diagnostic, so an error that only moved
/// with an edit still counts as pre-existing.
fn key(context: &str, normalized: &str) -> String {
    format!("{context}|{normalized}").chars().filter(|ch| !ch.is_ascii_digit()).collect()
}

fn mentions(normalized: &str, file: &str) -> bool {
    let file = normalize(file);
    normalized.match_indices(&file).any(|(index, _)| {
        let before = normalized[..index].chars().last();
        let after = normalized[index + file.len()..].chars().next();
        before.is_none_or(|ch| matches!(ch, '/' | ' ' | '"' | '\'' | '(' | ':'))
            && after.is_none_or(|ch| !ch.is_alphanumeric() && ch != '_' && ch != '.')
    })
}

/// (key, file, original line) for every error line. A non-indented line that
/// names a file and is not itself an error is a header (eslint/pyright
/// grouping); indented error lines below it belong to that file.
fn diagnostics(output: &str, files: &[String]) -> Vec<(String, Option<String>, String)> {
    let mut header = String::new();
    let mut header_file: Option<String> = None;
    let mut found = Vec::new();
    for raw in output.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let normalized = normalize(line);
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if !indented && !is_error(&normalized) {
            header = normalized.clone();
            header_file = files.iter().find(|file| mentions(&normalized, file)).cloned();
            continue;
        }
        if !is_error(&normalized) {
            continue;
        }
        let own = files.iter().find(|file| mentions(&normalized, file)).cloned();
        let (context, file) = match own {
            Some(file) => (String::new(), Some(file)),
            None if indented => (header.clone(), header_file.clone()),
            None => (String::new(), None),
        };
        found.push((key(&context, normalized.trim()), file, line.trim().to_owned()));
    }
    found
}

fn clip(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line.to_owned();
    }
    format!("{}…", line.chars().take(MAX_LINE_CHARS).collect::<String>())
}

/// The text block attached to the edit result.
fn report(id: &str, run: CheckRun, baseline: &HashSet<String>, changed: &BTreeSet<String>) -> String {
    let output = match run {
        CheckRun::TimedOut => {
            return format!("[fast check: {id}] timed out after {} s; no result (the edit was saved).", CHECK_TIMEOUT_MS / 1000)
        }
        CheckRun::Failed(error) => return format!("[fast check: {id}] could not run ({error}); no result (the edit was saved)."),
        CheckRun::Output(output) => output,
    };
    let files: Vec<String> = changed.iter().cloned().collect();
    let mut seen = HashSet::new();
    let fresh: Vec<String> = diagnostics(&output, &files)
        .into_iter()
        .filter(|(key, file, _)| file.is_some() && !baseline.contains(key) && seen.insert(key.clone()))
        .map(|(_, _, line)| clip(&line))
        .collect();
    if fresh.is_empty() {
        return format!("[fast check: {id}] no new errors in changed files.");
    }
    let mut text = format!("[fast check: {id}] {} new error line(s) in changed files:", fresh.len());
    for line in fresh.iter().take(MAX_LINES) {
        text.push('\n');
        text.push_str(line);
    }
    if fresh.len() > MAX_LINES {
        text.push_str(&format!("\n… {} more not shown", fresh.len() - MAX_LINES));
    }
    text
}

#[derive(Default)]
struct CheckState {
    /// Error keys present before this run's first write; `None` until taken.
    baseline: Option<HashSet<String>>,
    changed: BTreeSet<String>,
}

/// Wraps an executor so each successful file mutation carries the checker's
/// new errors. Calls are serialized by the state lock while a check runs, so a
/// check always sees the write it reports on.
pub fn wrap(executor: Arc<dyn ToolExecutor>, workspace: PathBuf, checker: DetectedChecker) -> Arc<dyn ToolExecutor> {
    let state = Arc::new(tokio::sync::Mutex::new(CheckState::default()));
    Arc::new(move |name: String, args: Value| {
        let (executor, workspace, checker, state) = (executor.clone(), workspace.clone(), checker.clone(), state.clone());
        async move {
            // The thin engine's native write/edit arrive as hub_fs_write {op:"write"}.
            let native = name == "hub_fs_write" && args.get("op").and_then(Value::as_str) == Some("write");
            if !matches!(name.as_str(), "hub_write" | "hub_edit") && !native {
                return executor.execute(name, args).await;
            }
            let mut path = args.get("path").and_then(Value::as_str).unwrap_or_default().to_owned();
            let mut state = state.lock().await;
            if state.baseline.is_none() {
                let baseline = match run_checker(&workspace, &checker).await {
                    CheckRun::Output(output) => diagnostics(&output, &[]).into_iter().map(|(key, _, _)| key).collect(),
                    _ => HashSet::new(),
                };
                state.baseline = Some(baseline);
            }
            let mut answer: ToolAnswer = executor.execute(name, args).await?;
            if native {
                // Pi sends an absolute path; Hub's answer names the workspace-relative one.
                path = answer.details.get("path").and_then(Value::as_str).unwrap_or_default().to_owned();
            }
            if !path.is_empty() {
                state.changed.insert(path);
            }
            let run = run_checker(&workspace, &checker).await;
            let text = report(&checker.id, run, state.baseline.as_ref().expect("baseline set above"), &state.changed);
            match answer.content.as_array_mut() {
                Some(blocks) => blocks.push(json!({"type":"text","text":text})),
                None => answer.content = json!([answer.content.clone(), {"type":"text","text":text}]),
            }
            if let Some(details) = answer.details.as_object_mut() {
                details.insert("fastCheck".into(), json!({"checker": checker.id}));
            }
            Ok(answer)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi_sidecar::{hub_executor, HubToolCaps};

    fn workspace() -> (crate::agent_tools::TestWorkspace, PathBuf) {
        let path = std::env::temp_dir().join(format!("hub-fast-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let path = path.canonicalize().unwrap();
        (crate::agent_tools::TestWorkspace { path: path.clone() }, path)
    }

    /// A stand-in checker: reports every line containing "BAD" in *.txt files
    /// as `path:line:1: error: bad token`, tsc-style.
    fn fake_checker(root: &Path, sleep_ms: u64, timeout_ms: u64) -> DetectedChecker {
        std::fs::write(root.join("check.cjs"), format!(
            "const fs=require('fs');const t=Date.now();while(Date.now()-t<{sleep_ms}){{}}\
             for(const f of fs.readdirSync('.').filter(f=>f.endsWith('.txt')).sort()){{\
             fs.readFileSync(f,'utf8').split(/\\r?\\n/).forEach((l,i)=>{{if(l.includes('BAD'))console.log(`${{f}}:${{i+1}}:1: error: bad token ${{l.trim()}}`)}})}}"
        )).unwrap();
        DetectedChecker {
            id: "fake".into(),
            command: VerificationCommand { program: "node".into(), args: vec!["check.cjs".into()], cwd: String::new(), timeout_ms: Some(timeout_ms) },
        }
    }

    fn text(answer: &ToolAnswer) -> String {
        answer.content.as_array().unwrap().iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn detection_proposes_only_local_offline_commands_and_selection_needs_the_exact_allowed_argv() {
        let (_dir, root) = workspace();
        assert!(detect(&root).is_empty());
        std::fs::write(root.join("tsconfig.json"), "{}").unwrap();
        assert!(detect(&root).is_empty(), "no local typescript: no tsc (never npx)");
        std::fs::create_dir_all(root.join("node_modules/typescript/bin")).unwrap();
        std::fs::write(root.join("node_modules/typescript/bin/tsc"), "").unwrap();
        std::fs::write(root.join("Cargo.toml"), "[package]").unwrap();
        std::fs::write(root.join("pyproject.toml"), "[tool.mypy]\n").unwrap();
        let ids: Vec<_> = detect(&root).into_iter().map(|checker| checker.id).collect();
        assert_eq!(ids, ["tsc", "cargo", "mypy"]);
        assert!(detect(&root)[1].command.args.contains(&"--offline".to_owned()));
        assert!(select(&root, &[]).is_none(), "detection alone allows nothing");
        let cargo = detect(&root)[1].command.clone();
        let mut altered = cargo.clone();
        altered.args.push("--all-targets".into());
        assert!(select(&root, &[altered]).is_none());
        let mut retimed = cargo.clone();
        retimed.timeout_ms = Some(5_000);
        assert_eq!(select(&root, &[retimed]).unwrap().id, "cargo");
    }

    #[test]
    fn only_new_error_lines_for_changed_files_are_reported_and_capped() {
        let baseline_output = "a.txt:1:1: error: old\nother.txt:3:1: error: elsewhere\n";
        let baseline: HashSet<String> = diagnostics(baseline_output, &[]).into_iter().map(|(key, _, _)| key).collect();
        let changed: BTreeSet<String> = ["a.txt".to_owned()].into();
        let moved = "a.txt:9:1: error: old\na.txt:2:1: error: fresh\nother.txt:4:1: error: new elsewhere\na.txt:5:1: warning: style\n";
        let text = report("fake", CheckRun::Output(moved.into()), &baseline, &changed);
        assert_eq!(text, "[fast check: fake] 1 new error line(s) in changed files:\na.txt:2:1: error: fresh");
        let many: String = (0..45).map(|i| format!("a.txt:{i}:1: error: e{}\n", "x".repeat(i))).collect();
        let text = report("fake", CheckRun::Output(many), &HashSet::new(), &changed);
        assert_eq!(text.lines().count(), 1 + MAX_LINES + 1);
        assert!(text.ends_with("… 15 more not shown"));
        // eslint/pyright grouping: indented lines belong to the header file.
        let grouped = "C:\\w\\src\\a.ts\n  3:1  error  no-undef  x\n  4:1  warning  y\nC:\\w\\src\\b.ts\n  1:1  error  z\n";
        let changed: BTreeSet<String> = ["src/a.ts".to_owned()].into();
        let text = report("eslint", CheckRun::Output(grouped.into()), &HashSet::new(), &changed);
        assert_eq!(text, "[fast check: eslint] 1 new error line(s) in changed files:\n3:1  error  no-undef  x");
        assert!(!mentions("src/ab.ts:1: error", "src/a.ts") && !mentions("xsrc/a.ts:1: error", "src/a.ts"));
    }

    #[tokio::test]
    async fn edit_results_carry_new_errors_without_extra_calls() {
        let (_dir, root) = workspace();
        std::fs::write(root.join("pre.txt"), "BAD legacy\n").unwrap();
        let checker = fake_checker(&root, 0, 10_000);
        let executor = wrap(hub_executor(root.clone(), true, HubToolCaps::default(), None), root.clone(), checker);
        let answer = executor.execute("hub_write".into(), json!({"path":"a.txt","content":"fine\n"})).await.unwrap();
        assert!(text(&answer).ends_with("[fast check: fake] no new errors in changed files."), "{}", text(&answer));
        executor.execute("hub_read".into(), json!({"path":"a.txt"})).await.unwrap();
        let answer = executor.execute("hub_edit".into(), json!({"path":"a.txt","content":json!({"oldText":"fine","newText":"BAD now"}).to_string()})).await.unwrap();
        let shown = text(&answer);
        assert!(shown.contains("1 new error line(s)") && shown.contains("a.txt:1:1: error: bad token BAD now"), "{shown}");
        assert!(!shown.contains("pre.txt"), "pre-existing errors in unchanged files stay out: {shown}");
        assert_eq!(answer.details["fastCheck"]["checker"], "fake");
        // Reads and failed writes are untouched.
        let read = executor.execute("hub_read".into(), json!({"path":"pre.txt"})).await.unwrap();
        assert!(!text(&read).contains("fast check"));
        assert!(executor.execute("hub_write".into(), json!({"path":"../x.txt","content":"x"})).await.is_err());
    }

    #[tokio::test]
    async fn a_slow_checker_times_out_and_the_edit_still_succeeds() {
        let (_dir, root) = workspace();
        let checker = fake_checker(&root, 5_000, 300);
        let executor = wrap(hub_executor(root.clone(), true, HubToolCaps::default(), None), root.clone(), checker);
        let started = std::time::Instant::now();
        let answer = executor.execute("hub_write".into(), json!({"path":"a.txt","content":"BAD\n"})).await.unwrap();
        assert!(text(&answer).contains("[fast check: fake] timed out"), "{}", text(&answer));
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "BAD\n");
        assert!(started.elapsed() < std::time::Duration::from_secs(4), "two bounded checks, not the full sleep");
    }
}
