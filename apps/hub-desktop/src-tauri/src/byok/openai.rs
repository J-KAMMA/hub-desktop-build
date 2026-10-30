//! OpenAI Chat Completions, also used for any OpenAI-compatible endpoint.
use super::{ChatMessage, Event};
use serde_json::{json, Value};

pub const DEFAULT_BASE: &str = "https://api.openai.com/v1";

pub fn models_url(base: &str) -> String {
    format!("{base}/models")
}

/// `official` filters the OpenAI list down to chat-capable families; a custom
/// endpoint's list is shown as it is.
pub fn parse_models(body: &Value, official: bool) -> Vec<String> {
    body.get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .filter(|id| !official || is_chat_model(id))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn is_chat_model(id: &str) -> bool {
    let family = ["gpt-", "chatgpt-", "o1", "o3", "o4"].iter().any(|p| id.starts_with(p));
    let other = [
        "embedding", "whisper", "tts", "dall-e", "moderation", "transcribe", "realtime", "audio", "image", "search", "instruct",
    ];
    family && !other.iter().any(|word| id.contains(word))
}

pub fn chat_url(base: &str) -> String {
    format!("{base}/chat/completions")
}

pub fn chat_body(model: &str, messages: &[ChatMessage], stream: bool, max_tokens: Option<u32>) -> Value {
    let mut body = json!({
        "model": model,
        "stream": stream,
        "messages": messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
    });
    if let Some(limit) = max_tokens {
        body["max_tokens"] = json!(limit);
    }
    body
}

pub fn parse_event(data: &str) -> Event {
    let data = data.trim();
    if data == "[DONE]" {
        return Event::Done;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Event::Skip;
    };
    if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
        let text = error.to_string().to_lowercase();
        return Event::Failed(if text.contains("quota") {
            "byok_quota_exceeded"
        } else if text.contains("rate") {
            "byok_rate_limited"
        } else if text.contains("invalid_api_key") || text.contains("authentication") {
            "byok_auth_failed"
        } else {
            "byok_provider_failed"
        });
    }
    match value.pointer("/choices/0/delta/content").and_then(Value::as_str) {
        Some(text) if !text.is_empty() => Event::Text(text.to_owned()),
        _ => Event::Skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_keeps_roles_and_omits_max_tokens_by_default() {
        let messages = vec![ChatMessage { role: "user".into(), content: "hi".into() }];
        let body = chat_body("gpt-5", &messages, true, None);
        assert_eq!(body, json!({"model": "gpt-5", "stream": true, "messages": [{"role": "user", "content": "hi"}]}));
        assert_eq!(chat_body("m", &messages, false, Some(1))["max_tokens"], 1);
        assert_eq!(chat_url("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/chat/completions");
    }

    #[test]
    fn official_list_drops_non_chat_models_but_custom_keeps_all() {
        let body = json!({"object": "list", "data": [{"id": "gpt-5"}, {"id": "text-embedding-3-small"}, {"id": "whisper-1"}, {"id": "o3-mini"}, {"id": "dall-e-3"}, {"id": "gpt-4o-realtime-preview"}, {"id": "anthropic/claude-sonnet-4.5"}]});
        assert_eq!(parse_models(&body, true), vec!["gpt-5", "o3-mini"]);
        assert_eq!(parse_models(&body, false).len(), 7);
    }

    #[test]
    fn stream_events_map_text_done_and_errors() {
        let chunk = r#"{"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"こん"},"finish_reason":null}]}"#;
        assert_eq!(parse_event(chunk), Event::Text("こん".into()));
        assert_eq!(parse_event(r#"{"choices":[{"delta":{"role":"assistant","content":""}}]}"#), Event::Skip);
        assert_eq!(parse_event(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#), Event::Skip);
        assert_eq!(parse_event(" [DONE]"), Event::Done);
        assert_eq!(parse_event(r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}"#), Event::Failed("byok_quota_exceeded"));
        assert_eq!(parse_event(r#"{"error":{"message":"boom","type":"server_error"}}"#), Event::Failed("byok_provider_failed"));
    }
}
