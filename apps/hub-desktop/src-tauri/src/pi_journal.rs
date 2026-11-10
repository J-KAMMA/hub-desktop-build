//! Bridge between the native harness and the MIT `hub-loop` journal
//! (owner decision 2026-11-06: commit every state change, model turn and tool
//! call to durable local storage before it reaches the window).
//!
//! The journal never grants anything. A resumed session re-runs only read-only
//! tools on its own; a side-effecting tool without a recorded result is shown
//! as interrupted, and an unanswered approval stays pending.
use hub_loop::{Effect, Store};
use serde_json::{json, Value};

pub(crate) const FOLDER: &str = "pi-journal";
/// Finished sessions kept on disk; the folder is also size-capped by `Store`.
pub(crate) const KEEP_FINISHED: usize = 100;

/// Tools whose repetition changes nothing outside the session. Anything not
/// listed here is treated as having side effects.
pub(crate) fn tool_effect(name: &str) -> Effect {
    match name {
        "hub_read" | "hub_read_range" | "hub_list" | "hub_search" | "hub_fs" | "hub_web_search"
        | "hub_catalog_search" | "hub_product_read" => Effect::ReadOnly,
        _ => Effect::SideEffect,
    }
}

/// Short status line about context compaction, carried on the run record
/// (`PiRunState.compaction`) so the existing poll channel shows it. UI hook for
/// later: app.js does not read `compaction` yet.
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionStatus {
    /// "running", "done" or "failed".
    pub phase: String,
    /// Completed compactions in this run.
    pub count: u32,
    pub line: String,
    pub tokens_before: Option<u64>,
    pub tokens_after: Option<u64>,
}

fn event_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|v| *v >= 0.0).map(|v| v as u64))
}

/// The `compacted` record for a finished engine compaction (`compaction_end`
/// with a result). `None` for start events, aborted or failed ones. The engine
/// (Pi) summarises with its own model call and has already swapped its context
/// when this arrives, so this record is the durable audit copy; it is
/// committed before the window sees the event. The covered range is the
/// engine's own (`first_kept`), not hub-loop turn ids, so it is `0..0` here.
pub(crate) fn compaction_record(event: &Value) -> Option<hub_loop::Compaction> {
    if event["type"] != "compaction_end" || event["aborted"] == true {
        return None;
    }
    let result = event.get("result").filter(|r| r.is_object())?;
    let summary: String = result["summary"].as_str()?.chars().take(hub_loop::compaction::MAX_SUMMARY_BYTES / 3).collect();
    Some(hub_loop::Compaction {
        covered_from: 0,
        covered_to: 0,
        covered_turns: 0,
        summary,
        tokens_before: event_u64(&result["tokensBefore"]).unwrap_or(0),
        tokens_after: event_u64(&result["estimatedTokensAfter"]).unwrap_or(0),
        reason: event["reason"].as_str().unwrap_or("threshold").chars().take(24).collect(),
        first_kept: result["firstKeptEntryId"].as_str().map(|s| s.chars().take(64).collect()),
    })
}

/// Updates the status line from an engine event. Pure display state.
pub(crate) fn observe_compaction(event: &Value, status: &mut Option<CompactionStatus>) {
    let count = status.as_ref().map_or(0, |s| s.count);
    match event["type"].as_str() {
        Some("compaction_start") => {
            *status = Some(CompactionStatus {
                phase: "running".into(),
                count,
                line: "会話を要約しています".into(),
                ..CompactionStatus::default()
            });
        }
        Some("compaction_end") => {
            let result = event.get("result").filter(|r| r.is_object());
            let done = result.is_some() && event["aborted"] != true && event["errorMessage"].is_null();
            *status = Some(if done {
                let result = result.unwrap_or(&Value::Null);
                let (before, after) = (event_u64(&result["tokensBefore"]), event_u64(&result["estimatedTokensAfter"]));
                let line = match (before, after) {
                    (Some(b), Some(a)) => format!("会話を要約しました（約{b}→約{a}トークン）"),
                    _ => "会話を要約しました".into(),
                };
                CompactionStatus { phase: "done".into(), count: count + 1, line, tokens_before: before, tokens_after: after }
            } else {
                // The engine keeps its full context when summarising fails.
                CompactionStatus {
                    phase: "failed".into(),
                    count,
                    line: "要約できなかったため、会話は元のまま続けます".into(),
                    ..CompactionStatus::default()
                }
            });
        }
        _ => {}
    }
}

pub(crate) fn store() -> Option<Store> {
    crate::checkpoint::folder_path(FOLDER).ok().map(Store::new)
}

/// Sessions that did not end cleanly: what may be retried, what is unknown,
/// and what is still waiting for a human. Display data only.
pub(crate) fn interrupted(store: &Store) -> Vec<Value> {
    let call = |t: &hub_loop::ToolRecord| json!({"callId": t.call_id, "name": t.name, "detail": t.detail});
    store
        .unfinished()
        .into_iter()
        .filter_map(|(id, state)| {
            let plan = state.plan();
            let workspace = state.session.as_ref().and_then(|s| s.get("workspace")).cloned();
            Some(json!({
                "runId": id,
                "workspace": workspace,
                "lastEventMs": state.last_timestamp_ms,
                "retryAutomatically": plan.retry.iter().map(call).collect::<Vec<_>>(),
                "interrupted": plan.interrupted.iter().map(call).collect::<Vec<_>>(),
                "pendingApprovals": plan.pending_approvals.iter()
                    .map(|a| json!({"id": a.approval_id, "tool": a.tool, "summary": a.summary}))
                    .collect::<Vec<_>>(),
                "openTurn": plan.open_turn,
            }))
        })
        .collect()
}

/// A crash leaves sessions without `done`. Record one `cancel` so they are not
/// mistaken for live work; they stay unfinished until the user resumes,
/// dismisses or deletes them.
pub(crate) fn mark_interrupted(store: &Store) {
    for (id, state) in store.unfinished() {
        if state.status == hub_loop::Status::Running {
            if let Ok(Some(journal)) = store.open_existing(&id) {
                let _ = journal.cancel("interrupted_by_restart");
            }
        }
    }
}

/// Sessions a crash or restart left open, with what is safe to retry, what
/// may or may not have happened, and what is still waiting for a person. Resume
/// goes through the existing `pi_work_start` with `resumeRunId`. Display data
/// only. (UI hook for later: app.js does not call this yet.)
#[tauri::command]
pub async fn pi_work_interrupted(window: tauri::Webview) -> Result<Vec<Value>, String> {
    crate::native_pi(&window)?;
    Ok(store().map(|store| interrupted(&store)).unwrap_or_default())
}

/// Closes an interrupted session's journal entry without resuming it. Decides
/// nothing: pending approvals are dropped, not approved.
#[tauri::command]
pub async fn pi_work_interrupted_dismiss(window: tauri::Webview, run_id: String) -> Result<(), String> {
    crate::native_pi(&window)?;
    let store = store().ok_or("pi_journal_unavailable")?;
    match store.open_existing(&run_id).map_err(|e| e.to_string())? {
        Some(journal) => journal.done("dismissed", false).map(|_| ()).map_err(|e| e.to_string()),
        None => Err("pi_work_not_found".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_commands_are_gated_to_bundled_ai_windows() {
        let source = include_str!("pi_journal.rs");
        for command in ["pi_work_interrupted(", "pi_work_interrupted_dismiss("] {
            let body = source.split(&format!("pub async fn {command}")).nth(1).expect("command body");
            let body = body.split("#[tauri::command]").next().unwrap_or(body);
            assert!(body.contains("window: tauri::Webview"), "{command}");
            assert!(body.contains("native_pi(&window)?"), "{command}");
        }
    }

    #[test]
    fn only_known_read_only_tools_are_retried() {
        for name in ["hub_read", "hub_read_range", "hub_list", "hub_search", "hub_fs", "hub_web_search"] {
            assert_eq!(tool_effect(name), Effect::ReadOnly, "{name}");
        }
        for name in ["hub_write", "hub_edit", "hub_fs_write", "hub_exec", "hub_shell", "hub_http", "hub_test", "hub_pay", "hub_finish", "unknown_tool", ""] {
            assert_eq!(tool_effect(name), Effect::SideEffect, "{name}");
        }
    }

    fn end(result: Value) -> Value {
        json!({"type": "compaction_end", "reason": "threshold", "aborted": false, "willRetry": false, "result": result})
    }

    #[test]
    fn compaction_end_is_journaled_and_replays_with_its_numbers() {
        let dir = temp();
        let store = Store::new(&dir);
        let j = store.open("run-c").unwrap();
        let event = end(json!({"summary": "Edited src/a.rs; cargo test failed; TODO: b.rs", "tokensBefore": 61000,
            "estimatedTokensAfter": 9000, "firstKeptEntryId": "e42"}));
        let record = compaction_record(&event).expect("record");
        j.model_turn_start(json!({})).unwrap();
        j.compacted(&record).unwrap();
        let state = j.replay().unwrap();
        assert_eq!(state.compactions.len(), 1);
        let c = &state.compactions[0];
        assert_eq!((c.tokens_before, c.tokens_after, c.first_kept.as_deref()), (61000, 9000, Some("e42")));
        assert!(c.summary.contains("src/a.rs") && c.summary.contains("TODO"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_aborted_and_start_events_write_no_record_and_keep_the_run_going() {
        assert!(compaction_record(&json!({"type": "compaction_start", "reason": "threshold"})).is_none());
        let aborted = json!({"type": "compaction_end", "aborted": true, "result": null, "errorMessage": "model down"});
        assert!(compaction_record(&aborted).is_none());
        let mut status = None;
        observe_compaction(&json!({"type": "compaction_start"}), &mut status);
        assert_eq!(status.as_ref().unwrap().phase, "running");
        observe_compaction(&aborted, &mut status);
        let s = status.as_ref().unwrap();
        assert_eq!((s.phase.as_str(), s.count), ("failed", 0));
        assert!(s.line.contains("元のまま"), "the user is told nothing was dropped");
    }

    #[test]
    fn status_line_counts_finished_compactions() {
        let mut status = None;
        for n in 1..=2u32 {
            observe_compaction(&json!({"type": "compaction_start"}), &mut status);
            observe_compaction(&end(json!({"summary": "s", "tokensBefore": 1000, "estimatedTokensAfter": 200})), &mut status);
            let s = status.as_ref().unwrap();
            assert_eq!((s.phase.as_str(), s.count), ("done", n));
            assert_eq!(s.line, "会話を要約しました（約1000→約200トークン）");
        }
        let wire = serde_json::to_value(status.unwrap()).unwrap();
        assert_eq!(wire["tokensBefore"], 1000);
    }

    #[test]
    fn the_observer_commits_compaction_before_it_changes_visible_state() {
        let source = include_str!("pi_work.rs");
        let committed = source.find("journal.compacted(&record)").expect("journals compaction");
        let shown = source.find("observe_compaction(&event, &mut state.compaction)").expect("status line");
        assert!(committed < shown);
    }

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pi-journal-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn restart_surfaces_interrupted_writes_and_pending_approvals_without_deciding_them() {
        let dir = temp();
        let store = Store::new(&dir);
        let j = store.open("run-1").unwrap();
        j.session(json!({"workspace": "C:/w"})).unwrap();
        j.tool_call("r", "hub_read", tool_effect("hub_read"), Some("a.txt")).unwrap();
        j.tool_call("w", "hub_write", tool_effect("hub_write"), Some("b.txt")).unwrap();
        j.tool_call("x", "hub_exec", tool_effect("hub_exec"), None).unwrap();
        j.approval_requested("ap", Some("x"), "hub_exec", "run build").unwrap();
        drop(j);
        mark_interrupted(&store);
        mark_interrupted(&store); // idempotent: only one cancel is recorded
        let list = interrupted(&store);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["retryAutomatically"][0]["callId"], "r");
        assert_eq!(list[0]["interrupted"].as_array().unwrap().len(), 1);
        assert_eq!(list[0]["interrupted"][0]["callId"], "w");
        assert_eq!(list[0]["pendingApprovals"][0]["id"], "ap");
        let state = store.open("run-1").unwrap().replay().unwrap();
        assert_eq!(state.approvals[0].decision, None);
        assert_eq!(state.last_seq, 6, "exactly one cancel record was appended");
        let _ = std::fs::remove_dir_all(dir);
    }
}
