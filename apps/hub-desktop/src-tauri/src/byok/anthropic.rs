//! Anthropic Messages API: request and response mapping only (no I/O).
use super::{ChatMessage, Event};
use serde_json::{json, Value};

pub const DEFAULT_BASE: &str = "https://api.anthropic.com";
pub const VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 8192;

pub fn models_url(base: &str) -> String {
    format!("{base}/v1/models?limit=100")
}

pub fn parse_models(body: &Value) -> Vec<String> {
    body.get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub fn chat_url(base: &str) -> String {
    format!("{base}/v1/messages")
}

pub fn chat_body(model: &str, messages: &[ChatMessage], stream: bool, max_tokens: Option<u32>) -> Value {
    json!({
        "model": model,
        "max_tokens": max_tokens.unwrap_or(MAX_TOKENS),
        "stream": stream,
        "messages": messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
    })
}

pub fn parse_event(data: &str) -> Event {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Event::Skip;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("content_block_delta") => {
            let delta = value.get("delta");
            match (
                delta.and_then(|d| d.get("type")).and_then(Value::as_str),
                delta.and_then(|d| d.get("text")).and_then(Value::as_str),
            ) {
                (Some("text_delta"), Some(text)) => Event::Text(text.to_owned()),
                _ => Event::Skip,
            }
        }
        Some("message_stop") => Event::Done,
        Some("error") => Event::Failed(match value.pointer("/error/type").and_then(Value::as_str) {
            Some("authentication_error" | "permission_error") => "byok_auth_failed",
            Some("rate_limit_error") => "byok_rate_limited",
            Some("not_found_error") => "byok_model_not_found",
            Some("invalid_request_error") => "byok_bad_request",
            _ => "byok_provider_failed",
        }),
        _ => Event::Skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation() -> Vec<ChatMessage> {
        vec![
            ChatMessage { role: "user".into(), content: "こんにちは".into() },
            ChatMessage { role: "assistant".into(), content: "はい".into() },
            ChatMessage { role: "user".into(), content: "続けて".into() },
        ]
    }

    #[test]
    fn request_maps_messages_and_requires_max_tokens() {
        let body = chat_body("claude-sonnet-4-5", &conversation(), true, None);
        assert_eq!(body["model"], "claude-sonnet-4-5");
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][1], json!({"role": "assistant", "content": "はい"}));
        assert_eq!(chat_url(DEFAULT_BASE), "https://api.anthropic.com/v1/messages");
        assert_eq!(chat_body("m", &conversation(), false, Some(1))["max_tokens"], 1);
    }

    #[test]
    fn models_are_read_from_the_data_array() {
        let body = json!({"data": [{"type": "model", "id": "claude-opus-4-1", "display_name": "Opus"}, {"id": "claude-haiku-4-5"}], "has_more": false});
        assert_eq!(parse_models(&body), vec!["claude-opus-4-1", "claude-haiku-4-5"]);
        assert!(parse_models(&json!({"nope": 1})).is_empty());
    }

    #[test]
    fn stream_events_map_to_text_done_and_errors() {
        let delta = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"やあ"}}"#;
        assert_eq!(parse_event(delta), Event::Text("やあ".into()));
        assert_eq!(parse_event(r#"{"type":"message_stop"}"#), Event::Done);
        assert_eq!(parse_event(r#"{"type":"ping"}"#), Event::Skip);
        assert_eq!(parse_event(r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}"#), Event::Skip);
        assert_eq!(parse_event("not json"), Event::Skip);
        assert_eq!(parse_event(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#), Event::Failed("byok_provider_failed"));
        assert_eq!(parse_event(r#"{"type":"error","error":{"type":"rate_limit_error","message":"x"}}"#), Event::Failed("byok_rate_limited"));
    }
}
