//! Read subscription limits from the operator's installed coding CLIs.
//!
//! Only quota labels, percentages and timestamps leave this module. Account names, email
//! addresses, tokens and the rest of each provider response never cross the
//! loopback API.
use serde::Serialize;
use serde_json::Value;
use std::{
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    time::timeout,
};

const USAGE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_BUCKETS: usize = 32;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub resets_at_ms: Option<i64>,
    pub resets_at_label: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent: String,
    pub windows: Vec<UsageWindow>,
    pub checked_at_ms: u64,
}

pub async fn read(agent: &str) -> Result<AgentUsage, &'static str> {
    let windows = match agent {
        "codex" => codex().await?,
        // /usage is an interactive UI command, not a documented read-only
        // machine endpoint. Never ask print mode to generate quota numbers.
        "claude" => return Err("usage unsupported"),
        _ => return Err("unknown agent"),
    };
    Ok(AgentUsage {
        agent: agent.to_owned(),
        windows,
        checked_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

async fn codex() -> Result<Vec<UsageWindow>, &'static str> {
    timeout(USAGE_TIMEOUT, codex_inner())
        .await
        .map_err(|_| "usage timed out")?
}

async fn codex_inner() -> Result<Vec<UsageWindow>, &'static str> {
    let (program, mut args) = crate::local_cli::codex_command().ok_or("codex not installed")?;
    args.extend(["app-server".into(), "--stdio".into()]);
    let mut child = crate::local_cli::quiet_command(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "usage unavailable")?;
    let mut stdin = child.stdin.take().ok_or("usage unavailable")?;
    let stdout = child.stdout.take().ok_or("usage unavailable")?;
    let mut lines = BufReader::new(stdout);

    write_json_line(&mut stdin, serde_json::json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": { "name": "hub-desktop", "title": "Hub Desktop", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true }
        }
    })).await?;
    let _ = response_for(&mut lines, 1).await?;
    write_json_line(&mut stdin, serde_json::json!({ "method": "initialized" })).await?;
    write_json_line(
        &mut stdin,
        serde_json::json!({ "id": 2, "method": "account/rateLimits/read", "params": null }),
    )
    .await?;
    let response = response_for(&mut lines, 2).await?;
    let _ = child.kill().await;
    parse_codex(&response)
}

async fn write_json_line(
    stdin: &mut tokio::process::ChildStdin,
    value: Value,
) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "usage unavailable")?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| "usage unavailable")?;
    stdin.flush().await.map_err(|_| "usage unavailable")
}

async fn response_for<R: AsyncBufRead + Unpin>(
    lines: &mut R,
    id: i64,
) -> Result<Value, &'static str> {
    for _ in 0..64 {
        let mut line = Vec::new();
        let count = (&mut *lines)
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "usage unavailable")?;
        if count == 0 || count > MAX_LINE_BYTES {
            return Err("usage unavailable");
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            if value.get("error").is_some() {
                return Err("usage unavailable");
            }
            return Ok(value);
        }
    }
    Err("usage unavailable")
}

fn parse_codex(response: &Value) -> Result<Vec<UsageWindow>, &'static str> {
    if let Some(buckets) = response
        .pointer("/result/rateLimitsByLimitId")
        .filter(|v| !v.is_null())
    {
        let buckets = buckets.as_object().ok_or("usage unavailable")?;
        if buckets.len() > MAX_BUCKETS {
            return Err("usage unavailable");
        }
        if !buckets.is_empty() {
            let mut windows = Vec::new();
            for (index, (id, snapshot)) in buckets.iter().enumerate() {
                let name = snapshot
                    .get("limitName")
                    .and_then(Value::as_str)
                    .filter(|name| {
                        !name.trim().is_empty()
                            && name.len() <= 100
                            && !name.chars().any(char::is_control)
                    })
                    .unwrap_or(id);
                if name.len() > 100 || name.chars().any(char::is_control) {
                    return Err("usage unavailable");
                }
                for mut window in parse_snapshot(snapshot)? {
                    window.id = format!("bucket_{index}_{}", window.id);
                    window.label = format!("{name} · {}", window.label);
                    windows.push(window);
                }
            }
            return nonempty(windows);
        }
    }
    let snapshot = response
        .pointer("/result/rateLimits")
        .ok_or("usage unavailable")?;
    nonempty(parse_snapshot(snapshot)?)
}

fn parse_snapshot(snapshot: &Value) -> Result<Vec<UsageWindow>, &'static str> {
    if !snapshot.is_object() {
        return Err("usage unavailable");
    }
    let mut windows = Vec::new();
    for (id, key) in [("primary", "primary"), ("secondary", "secondary")] {
        let Some(window) = snapshot.get(key).filter(|value| !value.is_null()) else {
            continue;
        };
        let used = window
            .get("usedPercent")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or("usage unavailable")?;
        let duration = window
            .get("windowDurationMins")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0);
        windows.push(UsageWindow {
            id: id.into(),
            label: duration_label(duration, id),
            used_percent: clamp_percent(used),
            remaining_percent: clamp_percent(100.0 - used),
            resets_at_ms: window
                .get("resetsAt")
                .and_then(Value::as_i64)
                .filter(|seconds| (0..=253_402_300_799).contains(seconds))
                .map(|seconds| seconds * 1000),
            resets_at_label: None,
        });
    }
    Ok(windows)
}

fn nonempty(windows: Vec<UsageWindow>) -> Result<Vec<UsageWindow>, &'static str> {
    (!windows.is_empty())
        .then_some(windows)
        .ok_or("usage unavailable")
}

fn duration_label(minutes: Option<i64>, slot: &str) -> String {
    match minutes {
        Some(300) => "5時間".into(),
        Some(1_440) => "1日".into(),
        Some(10_080) => "週間".into(),
        Some(value) => format!("{value}分枠"),
        None => if slot == "primary" {
            "第1枠"
        } else {
            "第2枠"
        }
        .into(),
    }
}

fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_rate_limit_without_account_metadata() {
        let response = serde_json::json!({"id":2,"result":{"rateLimits":{"planType":"pro","primary":{"usedPercent":16,"windowDurationMins":10080,"resetsAt":1787803976},"secondary":null}}});
        assert_eq!(
            parse_codex(&response).unwrap(),
            vec![UsageWindow {
                id: "primary".into(),
                label: "週間".into(),
                used_percent: 16.0,
                remaining_percent: 84.0,
                resets_at_ms: Some(1_787_803_976_000),
                resets_at_label: None,
            }]
        );
    }

    #[test]
    fn prefers_multiple_buckets_without_duplicating_legacy_or_forwarding_metadata() {
        let response = serde_json::json!({"result": {
            "rateLimits": {"primary": {"usedPercent": 99}},
            "rateLimitsByLimitId": {
                "codex": {"planType":"pro", "credits":{"balance":"123"}, "primary":{"usedPercent":20,"windowDurationMins":300},"secondary":{"usedPercent":40,"windowDurationMins":10080}},
                "codex_other": {"limitName":"Other model", "primary":{"usedPercent":80,"windowDurationMins":60}}
            }
        }});
        let windows = parse_codex(&response).unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "codex · 5時間");
        assert_eq!(windows[1].remaining_percent, 60.0);
        assert_eq!(windows[2].label, "Other model · 60分枠");
        assert_ne!(windows[0].id, windows[2].id);
        let serialized = serde_json::to_value(windows).unwrap();
        assert!(serialized.as_array().unwrap().iter().all(|window| window
            .as_object()
            .unwrap()
            .len()
            == 6));
    }

    #[test]
    fn refuses_missing_or_invented_usage() {
        for limits in [
            serde_json::json!({}),
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!({"primary":{"usedPercent":null}}),
            serde_json::json!({"primary":{"usedPercent":"0"}}),
        ] {
            assert_eq!(
                parse_codex(&serde_json::json!({"result":{"rateLimits":limits}})).unwrap_err(),
                "usage unavailable"
            );
        }
        for buckets in [
            serde_json::json!([]),
            serde_json::json!({"codex": null}),
            serde_json::json!({"codex":{}}),
        ] {
            assert_eq!(parse_codex(&serde_json::json!({"result":{"rateLimitsByLimitId":buckets,"rateLimits":{"primary":{"usedPercent":0}}}})).unwrap_err(), "usage unavailable");
        }
    }

    #[test]
    fn bounds_percentages_reset_times_and_bucket_counts() {
        for (used, expected) in [(-5.0, 0.0), (0.0, 0.0), (100.0, 100.0), (150.0, 100.0)] {
            for reset in [i64::MIN, -1, i64::MAX, 253_402_300_800] {
                let windows = parse_snapshot(&serde_json::json!({"primary":{"usedPercent":used,"resetsAt":reset,"windowDurationMins":-1}})).unwrap();
                assert_eq!(windows[0].used_percent, expected);
                assert_eq!(windows[0].remaining_percent, 100.0 - expected);
                assert_eq!(windows[0].resets_at_ms, None);
                assert_eq!(windows[0].label, "第1枠");
            }
        }
        let buckets: serde_json::Map<String, Value> = (0..=MAX_BUCKETS)
            .map(|i| {
                (
                    i.to_string(),
                    serde_json::json!({"primary":{"usedPercent":1}}),
                )
            })
            .collect();
        assert!(
            parse_codex(&serde_json::json!({"result":{"rateLimitsByLimitId":buckets}})).is_err()
        );
        for buckets in [Value::Null, serde_json::json!({})] {
            assert_eq!(parse_codex(&serde_json::json!({"result":{"rateLimitsByLimitId":buckets,"rateLimits":{"primary":{"usedPercent":0,"resetsAt":0}}}})).unwrap()[0].resets_at_ms, Some(0));
        }
    }

    #[tokio::test]
    async fn bounds_protocol_lines_and_ignores_unrelated_responses() {
        let valid = b"{\"id\":2,\"result\":{}}\n";
        let mut exact = vec![b' '; MAX_LINE_BYTES - valid.len()];
        exact.extend_from_slice(valid);
        assert!(response_for(&mut exact.as_slice(), 2).await.is_ok());
        exact.insert(0, b' ');
        assert!(response_for(&mut exact.as_slice(), 2).await.is_err());
        assert!(response_for(
            &mut b"invalid\n{\"method\":\"notify\"}\n{\"id\":2,\"result\":{}}\n".as_slice(),
            2
        )
        .await
        .is_ok());
        assert!(response_for(
            &mut b"{\"id\":2,\"error\":{\"message\":\"private\"}}\n".as_slice(),
            2
        )
        .await
        .is_err());
        assert!(response_for(&mut b"".as_slice(), 2).await.is_err());
        let excessive = b"{}\n".repeat(64);
        assert!(response_for(&mut excessive.as_slice(), 2).await.is_err());
    }

    #[tokio::test]
    #[ignore = "requires the operator's signed-in Codex CLI"]
    async fn reads_real_codex_usage() {
        let usage = read("codex").await.unwrap();
        assert_eq!(usage.agent, "codex");
        assert!(!usage.windows.is_empty());
    }

    #[tokio::test]
    async fn unsupported_providers_never_start_inference() {
        assert_eq!(read("claude").await.unwrap_err(), "usage unsupported");
        assert_eq!(read("custom").await.unwrap_err(), "unknown agent");
    }
}
