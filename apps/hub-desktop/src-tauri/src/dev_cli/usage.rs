use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A provider's final report for this invocation, not account billing. Missing
/// cache counters stay unknown. Claude's input excludes cache; Codex's includes it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub uncached_input_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub output_tokens: u64,
}

fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|&n| n <= MAX_SAFE_INTEGER)
}

fn optional_count(usage: &Value, key: &str) -> Option<Option<u64>> {
    match usage.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(value) => count(value).map(Some),
    }
}

pub fn final_report(agent: &str, line: &str) -> Option<TokenUsage> {
    let event: Value = serde_json::from_str(line).ok()?;
    match (agent, event["type"].as_str()?) {
        ("codex", "turn.completed") | ("claude", "result") => (),
        _ => return None,
    }
    let usage = &event["usage"];
    let input = count(&usage["input_tokens"])?;
    let output_tokens = count(&usage["output_tokens"])?;
    let (input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens) =
        if agent == "codex" {
            let cached = optional_count(usage, "cached_input_tokens")?;
            let uncached = match cached {
                Some(cached) => Some(input.checked_sub(cached)?),
                None => None,
            };
            (Some(input), uncached, cached, None)
        } else {
            let read = optional_count(usage, "cache_read_input_tokens")?;
            let write = optional_count(usage, "cache_creation_input_tokens")?;
            let total = match (read, write) {
                (Some(read), Some(write)) => {
                    let total = input.checked_add(read)?.checked_add(write)?;
                    if total > MAX_SAFE_INTEGER {
                        return None;
                    }
                    Some(total)
                }
                _ => None,
            };
            (total, Some(input), read, write)
        };
    Some(TokenUsage {
        input_tokens,
        uncached_input_tokens,
        cache_read_tokens,
        cache_write_tokens,
        output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn usage_survives_poll_checkpoint_and_history_without_recounting() {
        use super::super::{append, checkpoint_record, DevRun, DevRunRecord, DevRuns};
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let directory =
            std::env::temp_dir().join(format!("hub-cli-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let store = Arc::new(crate::checkpoint::CheckpointStore::test(
            directory.clone(),
            [7; 32],
        ));
        let id = uuid::Uuid::new_v4().to_string();
        let run = Arc::new(Mutex::new(DevRun {
            id: id.clone(),
            agent: "codex".into(),
            status: "running",
            ..Default::default()
        }));
        let state = Arc::new(Mutex::new(DevRuns::default()));
        state.lock().await.runs.insert(id.clone(), run.clone());
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":0}}"#;
        assert!(!append(&run, line, false, Some(&store)).await);
        assert!(
            run.lock().await.usage.is_none(),
            "stderr is not a usage report"
        );
        assert!(!append(&run, line, true, Some(&store)).await);
        let expected = final_report("codex", line).unwrap();
        assert!(!append(&run, line, true, Some(&store)).await);
        assert!(!append(&run, r#"{"type":"assistant","message":{"usage":{"input_tokens":999,"output_tokens":999}}}"#, true, Some(&store)).await);
        assert_eq!(run.lock().await.usage, Some(expected.clone()));
        let poll = DevRuns::poll(&state, &id, usize::MAX).await.unwrap();
        assert_eq!(poll["output"], "");
        assert_eq!(poll["usage"], serde_json::to_value(&expected).unwrap());
        let saved: DevRunRecord = store.load(&id).unwrap();
        assert_eq!(
            saved.usage,
            Some(expected.clone()),
            "usage-only events checkpoint too"
        );
        let restarted = DevRuns::with_store(store);
        assert_eq!(restarted.history()[0].record.usage, Some(expected));

        let guard = run.lock().await;
        let mut legacy = serde_json::to_value(checkpoint_record(&guard)).unwrap();
        legacy.as_object_mut().unwrap().remove("usage");
        assert!(serde_json::from_value::<DevRunRecord>(legacy)
            .unwrap()
            .usage
            .is_none());
        assert!(
            DevRun::default().usage.is_none(),
            "a new/resumed invocation starts without old usage"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reconciles_provider_input_semantics_without_inventing_cache_counts() {
        let codex = final_report(
            "codex",
            &json!({"type":"turn.completed", "usage":{
                "input_tokens":82790,"cached_input_tokens":59392,"output_tokens":884
            }})
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            codex,
            TokenUsage {
                input_tokens: Some(82790),
                uncached_input_tokens: Some(23398),
                cache_read_tokens: Some(59392),
                cache_write_tokens: None,
                output_tokens: 884
            }
        );
        let claude = final_report("claude", &json!({"type":"result", "is_error":true,"usage":{
            "input_tokens":20,"cache_read_input_tokens":200,"cache_creation_input_tokens":10,"output_tokens":6
        }}).to_string()).unwrap();
        assert_eq!(
            claude,
            TokenUsage {
                input_tokens: Some(230),
                uncached_input_tokens: Some(20),
                cache_read_tokens: Some(200),
                cache_write_tokens: Some(10),
                output_tokens: 6
            }
        );
        for (agent, kind) in [("codex", "turn.completed"), ("claude", "result")] {
            let absent = final_report(
                agent,
                &json!({"type":kind,"usage":{"input_tokens":0,"output_tokens":0}}).to_string(),
            )
            .unwrap();
            assert_eq!(absent.cache_read_tokens, None);
            assert_eq!(absent.cache_write_tokens, None);
            assert_eq!(absent.input_tokens, (agent == "codex").then_some(0));
            assert_eq!(
                absent.uncached_input_tokens,
                (agent == "claude").then_some(0)
            );
            assert_eq!(absent.output_tokens, 0);
        }
    }

    #[test]
    fn refuses_partial_wrong_provider_and_invalid_numeric_reports() {
        for (agent, kind) in [
            ("claude", "assistant"),
            ("codex", "item.completed"),
            ("other", "result"),
            ("claude", "turn.completed"),
        ] {
            assert!(final_report(
                agent,
                &json!({"type":kind,"usage":{"input_tokens":1,"output_tokens":2}}).to_string()
            )
            .is_none());
        }
        for invalid in [
            json!(-1),
            json!(1.5),
            json!(true),
            json!("10"),
            json!(MAX_SAFE_INTEGER + 1),
        ] {
            for key in ["input_tokens", "cached_input_tokens", "output_tokens"] {
                let mut event = json!({"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2}});
                event["usage"][key] = invalid.clone();
                assert!(final_report("codex", &event.to_string()).is_none());
            }
        }
        for line in [
            "not json",
            r#"{"type":"turn.completed"}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":2,"output_tokens":0}}"#,
        ] {
            assert!(final_report("codex", line).is_none());
        }
        let mut boundary = json!({"type":"result","usage":{"input_tokens":MAX_SAFE_INTEGER,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":MAX_SAFE_INTEGER}});
        assert!(final_report("claude", &boundary.to_string()).is_some());
        boundary["usage"]["cache_creation_input_tokens"] = json!(1);
        assert!(final_report("claude", &boundary.to_string()).is_none());
    }
}
