//! Google Gemini generateContent (streamed as SSE).
use super::{ChatMessage, Event};
use serde_json::{json, Value};

pub const DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com";

pub fn models_url(base: &str) -> String {
    format!("{base}/v1beta/models?pageSize=200")
}

/// Strips the `models/` prefix and keeps models that can generate content.
pub fn parse_models(body: &Value) -> Vec<String> {
    body.get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("supportedGenerationMethods")
                        .and_then(Value::as_array)
                        .map_or(true, |methods| methods.iter().any(|m| m == "generateContent"))
                })
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .map(|name| name.strip_prefix("models/").unwrap_or(name).to_owned())
                .collect()
        })
        .unwrap_or_default()
}

pub fn chat_url(base: &str, model: &str, stream: bool) -> String {
    if stream {
        format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse")
    } else {
        format!("{base}/v1beta/models/{model}:generateContent")
    }
}

pub fn chat_body(messages: &[ChatMessage], max_tokens: Option<u32>) -> Value {
    let mut body = json!({
        "contents": messages.iter().map(|m| json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{"text": m.content}],
        })).collect::<Vec<_>>(),
    });
    if let Some(limit) = max_tokens {
        body["generationConfig"] = json!({"maxOutputTokens": limit});
    }
    body
}

pub fn parse_event(data: &str) -> Event {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Event::Skip;
    };
    if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
        return Event::Failed(match error.get("status").and_then(Value::as_str) {
            Some("UNAUTHENTICATED" | "PERMISSION_DENIED") => "byok_auth_failed",
            Some("RESOURCE_EXHAUSTED") => "byok_rate_limited",
            Some("NOT_FOUND") => "byok_model_not_found",
            Some("INVALID_ARGUMENT") => "byok_bad_request",
            _ => "byok_provider_failed",
        });
    }
    if value.pointer("/promptFeedback/blockReason").is_some() {
        return Event::Failed("byok_blocked");
    }
    let text: String = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    if !text.is_empty() {
        Event::Text(text)
    } else if matches!(
        value.pointer("/candidates/0/finishReason").and_then(Value::as_str),
        Some("SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "BLOCKLIST")
    ) {
        Event::Failed("byok_blocked")
    } else {
        Event::Skip
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_maps_assistant_to_model_role() {
        let messages = vec![
            ChatMessage { role: "user".into(), content: "a".into() },
            ChatMessage { role: "assistant".into(), content: "b".into() },
        ];
        let body = chat_body(&messages, None);
        assert_eq!(body["contents"][1], json!({"role": "model", "parts": [{"text": "b"}]}));
        assert!(body.get("generationConfig").is_none());
        assert_eq!(chat_body(&messages, Some(1))["generationConfig"]["maxOutputTokens"], 1);
        assert_eq!(
            chat_url(DEFAULT_BASE, "gemini-2.5-pro", true),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn models_drop_prefix_and_non_generating_entries() {
        let body = json!({"models": [
            {"name": "models/gemini-2.5-pro", "supportedGenerationMethods": ["generateContent", "countTokens"]},
            {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]}]});
        assert_eq!(parse_models(&body), vec!["gemini-2.5-pro"]);
    }

    #[test]
    fn stream_chunks_join_parts_and_map_errors() {
        let chunk = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"こん"},{"text":"にちは"}]},"index":0}]}"#;
        assert_eq!(parse_event(chunk), Event::Text("こんにちは".into()));
        assert_eq!(parse_event(r#"{"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}]}"#), Event::Skip);
        assert_eq!(parse_event(r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#), Event::Failed("byok_blocked"));
        assert_eq!(parse_event(r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"x"}}"#), Event::Failed("byok_rate_limited"));
        assert_eq!(parse_event(r#"{"error":{"code":403,"status":"PERMISSION_DENIED"}}"#), Event::Failed("byok_auth_failed"));
    }
}
