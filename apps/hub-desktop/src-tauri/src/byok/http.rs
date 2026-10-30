//! Endpoint policy, error classification and SSE line splitting. No secrets pass through here
//! except as the opaque value the caller puts in a header.

use super::store::Kind;

pub const BODY_PEEK_LIMIT: usize = 16 * 1024;
const SSE_BUFFER_LIMIT: usize = 1024 * 1024;

fn loopback(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// Fixed providers ignore any supplied URL. A custom endpoint must be https, or http on a
/// loopback host, with no credentials, query or fragment. Returns the base without a trailing slash.
pub fn base_url(kind: Kind, supplied: Option<&str>) -> Result<String, &'static str> {
    match kind {
        Kind::Anthropic => Ok(super::anthropic::DEFAULT_BASE.into()),
        Kind::Openai => Ok(super::openai::DEFAULT_BASE.into()),
        Kind::Google => Ok(super::gemini::DEFAULT_BASE.into()),
        Kind::OpenaiCompatible => {
            let raw = supplied.map(str::trim).filter(|v| !v.is_empty()).ok_or("byok_endpoint_not_allowed")?;
            if raw.len() > 512 || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
                return Err("byok_endpoint_not_allowed");
            }
            let url = reqwest::Url::parse(raw).map_err(|_| "byok_endpoint_not_allowed")?;
            let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback(&url));
            if !scheme_ok
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("byok_endpoint_not_allowed");
            }
            Ok(url.as_str().trim_end_matches('/').to_owned())
        }
    }
}

pub fn is_loopback_base(base: &str) -> bool {
    reqwest::Url::parse(base).map(|u| loopback(&u)).unwrap_or(false)
}

/// Maps a failed HTTP response to a stable code. The body is only inspected for keywords and is
/// never returned, because a provider may echo request details back.
pub fn classify(status: u16, body: &str) -> &'static str {
    let body = body.to_lowercase();
    let quota = ["insufficient_quota", "exceeded your current quota", "credit balance", "billing", "quota"]
        .iter()
        .any(|word| body.contains(word));
    match status {
        401 | 403 => "byok_auth_failed",
        402 => "byok_quota_exceeded",
        400 if body.contains("api_key_invalid") || body.contains("api key not valid") => "byok_auth_failed",
        400 if body.contains("credit balance") => "byok_quota_exceeded",
        404 => "byok_model_not_found",
        408 | 504 => "byok_timeout",
        429 if quota => "byok_quota_exceeded",
        429 => "byok_rate_limited",
        400 | 413 | 422 => "byok_bad_request",
        _ => "byok_provider_failed",
    }
}

/// Splits a byte stream into the payloads of SSE `data:` lines. Only complete lines are decoded,
/// so a multi-byte character cut across two chunks is never mangled.
#[derive(Default)]
pub struct SseBuffer {
    pending: Vec<u8>,
}

impl SseBuffer {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, &'static str> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if let Some(rest) = line.strip_prefix("data:") {
                out.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
            }
        }
        if self.pending.len() > SSE_BUFFER_LIMIT {
            return Err("byok_response_too_large");
        }
        Ok(out)
    }
}

/// Model ids go into request bodies (and, for Gemini, a URL path), so keep them plain.
pub fn valid_model(kind: Kind, id: &str) -> bool {
    if id.is_empty() || id.len() > 200 {
        return false;
    }
    let charset = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@');
    match kind {
        Kind::Google => id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')),
        _ => id.chars().all(charset) && !id.contains(".."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_endpoints_need_https_or_loopback_and_no_embedded_secrets() {
        let ok = |s: &str| base_url(Kind::OpenaiCompatible, Some(s));
        assert_eq!(ok("https://openrouter.ai/api/v1/").unwrap(), "https://openrouter.ai/api/v1");
        assert_eq!(ok("http://localhost:1234/v1").unwrap(), "http://localhost:1234/v1");
        assert_eq!(ok("http://127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(ok("http://[::1]:11434/v1").unwrap(), "http://[::1]:11434/v1");
        for bad in [
            "http://example.com/v1",
            "http://192.168.0.5:1234/v1",
            "http://localhost.evil.com/v1",
            "ftp://localhost/v1",
            "https://user:pw@example.com/v1",
            "https://example.com/v1?key=1",
            "https://example.com/v1#x",
            "https://exa mple.com",
            "",
            "not a url",
        ] {
            assert_eq!(ok(bad), Err("byok_endpoint_not_allowed"), "{bad}");
        }
        assert_eq!(base_url(Kind::OpenaiCompatible, None), Err("byok_endpoint_not_allowed"));
    }

    #[test]
    fn fixed_providers_ignore_a_supplied_url() {
        assert_eq!(base_url(Kind::Anthropic, Some("https://evil.example")).unwrap(), "https://api.anthropic.com");
        assert_eq!(base_url(Kind::Openai, None).unwrap(), "https://api.openai.com/v1");
        assert_eq!(base_url(Kind::Google, None).unwrap(), "https://generativelanguage.googleapis.com");
    }

    #[test]
    fn statuses_map_to_codes_without_exposing_bodies() {
        assert_eq!(classify(401, "{\"error\":\"Incorrect API key provided: sk-abc\"}"), "byok_auth_failed");
        assert_eq!(classify(429, "Rate limit reached"), "byok_rate_limited");
        assert_eq!(classify(429, "{\"error\":{\"code\":\"insufficient_quota\"}}"), "byok_quota_exceeded");
        assert_eq!(classify(400, "Your credit balance is too low"), "byok_quota_exceeded");
        assert_eq!(classify(400, "{\"error\":{\"status\":\"INVALID_ARGUMENT\",\"message\":\"API key not valid\"}}"), "byok_auth_failed");
        assert_eq!(classify(400, "bad field"), "byok_bad_request");
        assert_eq!(classify(404, ""), "byok_model_not_found");
        assert_eq!(classify(503, ""), "byok_provider_failed");
        assert!(!classify(401, "sk-secret").contains("sk-"));
    }

    #[test]
    fn sse_lines_are_reassembled_across_chunks_and_multibyte_splits() {
        let mut buffer = SseBuffer::default();
        let text = "data: {\"a\":\"あ\"}\r\n\r\nevent: x\ndata:[DONE]\n";
        let bytes = text.as_bytes();
        let cut = text.find('あ').unwrap() + 1; // inside the 3-byte character
        assert!(buffer.push(&bytes[..cut]).unwrap().is_empty());
        let got = buffer.push(&bytes[cut..]).unwrap();
        assert_eq!(got, vec!["{\"a\":\"あ\"}".to_owned(), "[DONE]".to_owned()]);
    }

    #[test]
    fn sse_buffer_refuses_unbounded_lines() {
        let mut buffer = SseBuffer::default();
        assert_eq!(buffer.push(&vec![b'x'; SSE_BUFFER_LIMIT + 1]), Err("byok_response_too_large"));
    }

    #[test]
    fn model_ids_are_plain() {
        assert!(valid_model(Kind::Openai, "anthropic/claude-sonnet-4.5:beta"));
        assert!(valid_model(Kind::Google, "gemini-2.5-pro"));
        assert!(!valid_model(Kind::Google, "gemini/../x"));
        assert!(!valid_model(Kind::Openai, "a b"));
        assert!(!valid_model(Kind::Openai, "a\nb"));
        assert!(!valid_model(Kind::Anthropic, ""));
    }
}
