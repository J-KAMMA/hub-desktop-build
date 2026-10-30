use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_RELAY: &str = "https://hub-p2p-test.jammakamma0.workers.dev";
const MAX_FRAME_BYTES: usize = 90_028;
const MAX_EXPIRY_MS: u64 = 660_000;
const INPUT_ERROR: &str = "接続の入力を確認できませんでした";
const RESPONSE_ERROR: &str = "接続サービスの応答を確認できませんでした";
const NETWORK_ERROR: &str =
    "接続サービスに届きません。利用するHubの許可設定や回線を確認してください。";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Relay {
    Default,
    Hub,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Guest,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Start,
    Poll,
    Signal,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingRequest {
    pub relay: Relay,
    pub room: String,
    pub role: Role,
    pub expires: u64,
    pub operation: Operation,
    #[serde(default, deserialize_with = "deserialize_frame")]
    pub frame: Option<Vec<u8>>,
}

// Missing is allowed; an explicitly supplied frame must be a byte array.
fn deserialize_frame<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<u8>>, D::Error> {
    struct FrameVisitor;
    impl<'de> serde::de::Visitor<'de> for FrameVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an encrypted byte array of at most 90028 bytes")
        }

        fn visit_seq<S: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: S,
        ) -> Result<Self::Value, S::Error> {
            if sequence
                .size_hint()
                .is_some_and(|length| length > MAX_FRAME_BYTES)
            {
                return Err(serde::de::Error::custom(INPUT_ERROR));
            }
            let mut frame = Vec::with_capacity(sequence.size_hint().unwrap_or(29));
            while let Some(byte) = sequence.next_element::<u8>()? {
                if frame.len() == MAX_FRAME_BYTES {
                    return Err(serde::de::Error::custom(INPUT_ERROR));
                }
                frame.push(byte);
            }
            Ok(frame)
        }
    }
    deserializer.deserialize_seq(FrameVisitor).map(Some)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PairingResponse {
    pub status: u16,
    pub frame: Option<Vec<u8>>,
}

fn now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .ok_or_else(|| INPUT_ERROR.to_owned())
}

fn hub_origin(base: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base).map_err(|_| INPUT_ERROR)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if base.len() > 2048
        || base
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
    {
        return Err(INPUT_ERROR.to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

fn validate(request: &PairingRequest, now: u64) -> Result<(), String> {
    if request.room.len() != 32
        || !request
            .room
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request.expires <= now
        || request.expires > now.saturating_add(MAX_EXPIRY_MS)
        || !(1_000_000_000_000..=9_999_999_999_999).contains(&request.expires)
        || match (&request.operation, &request.frame) {
            (Operation::Signal, Some(frame)) => !(29..=MAX_FRAME_BYTES).contains(&frame.len()),
            (Operation::Signal, None) => true,
            (_, Some(_)) => true,
            (_, None) => false,
        }
    {
        return Err(INPUT_ERROR.to_owned());
    }
    Ok(())
}

fn request_url(origin: &str, request: &PairingRequest) -> Result<reqwest::Url, String> {
    let relay = match request.relay {
        Relay::Default => DEFAULT_RELAY,
        Relay::Hub => origin,
    };
    let role = match request.role {
        Role::Host => "host",
        Role::Guest => "guest",
    };
    let mut url = reqwest::Url::parse(relay).map_err(|_| INPUT_ERROR)?;
    url.set_path(&format!("/pair/{}/{role}", request.room));
    url.query_pairs_mut()
        .append_pair("expires", &request.expires.to_string())
        .append_pair("transport", "http");
    if request.operation != Operation::Poll {
        url.query_pairs_mut().append_pair(
            "action",
            if request.operation == Operation::Start {
                "start"
            } else {
                "signal"
            },
        );
    }
    Ok(url)
}

fn status_allowed(operation: Operation, status: u16) -> bool {
    matches!(
        status,
        400 | 403 | 404 | 405 | 409 | 410 | 413 | 429 | 500 | 502 | 503 | 504
    ) || match operation {
        Operation::Poll => matches!(status, 200 | 202 | 204),
        _ => status == 204,
    }
}

fn append_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if body.len() > MAX_FRAME_BYTES || chunk.len() > MAX_FRAME_BYTES.saturating_sub(body.len()) {
        return Err(RESPONSE_ERROR.to_owned());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn read_response(
    mut response: reqwest::Response,
    operation: Operation,
) -> Result<PairingResponse, String> {
    let status = response.status().as_u16();
    if !status_allowed(operation, status)
        || response
            .headers()
            .contains_key(reqwest::header::CONTENT_ENCODING)
        || response
            .content_length()
            .is_some_and(|length| length > MAX_FRAME_BYTES as u64)
    {
        return Err(RESPONSE_ERROR.to_owned());
    }
    if status == 200 {
        let headers = response.headers();
        if headers
            .get_all(reqwest::header::CONTENT_TYPE)
            .iter()
            .count()
            != 1
            || !headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/octet-stream"))
        {
            return Err(RESPONSE_ERROR.to_owned());
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NETWORK_ERROR.to_owned())?
    {
        append_chunk(&mut body, &chunk)?;
    }
    if status == 200 && body.len() < 29 || matches!(status, 202 | 204) && !body.is_empty() {
        return Err(RESPONSE_ERROR.to_owned());
    }
    Ok(PairingResponse {
        status,
        frame: (status == 200).then_some(body),
    })
}

/// The caller must gate this to the bundled main window and supply its current Hub URL.
/// This client is independent of authenticated Hub clients and never uses their credentials.
pub async fn request(base: &str, request: PairingRequest) -> Result<PairingResponse, String> {
    validate(&request, now_ms()?)?;
    let origin = hub_origin(base)?;
    let url = request_url(&origin, &request)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| NETWORK_ERROR.to_owned())?;
    let method = if request.operation == Operation::Poll {
        reqwest::Method::GET
    } else {
        reqwest::Method::POST
    };
    let mut builder = client
        .request(method, url)
        .header(reqwest::header::ORIGIN, origin)
        .header(reqwest::header::CACHE_CONTROL, "no-store");
    if let Some(frame) = request.frame {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(frame);
    }
    read_response(
        builder.send().await.map_err(|_| NETWORK_ERROR.to_owned())?,
        request.operation,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    const NOW: u64 = 1_791_000_000_000;
    fn input(operation: Operation) -> PairingRequest {
        PairingRequest {
            relay: Relay::Hub,
            room: "0123456789abcdef0123456789abcdef".into(),
            role: Role::Host,
            expires: NOW + 600_000,
            operation,
            frame: (operation == Operation::Signal).then(|| vec![0; 29]),
        }
    }

    #[test]
    fn strict_input_rejects_unknown_fields_and_non_bytes() {
        let value = serde_json::json!({"relay":"hub","room":"0123456789abcdef0123456789abcdef","role":"host","expires":NOW+600000,"operation":"start"});
        assert!(serde_json::from_value::<PairingRequest>(value.clone()).is_ok());
        for (key, bad) in [
            ("url", serde_json::json!("https://other.invalid")),
            ("key", serde_json::json!("secret")),
            ("relay", serde_json::json!("https://other.invalid")),
            ("role", serde_json::json!("admin")),
            ("operation", serde_json::json!("delete")),
            ("expires", serde_json::json!(1.5)),
            ("expires", serde_json::json!(-1)),
            ("frame", serde_json::json!([256])),
            ("frame", serde_json::json!([-1])),
            ("frame", serde_json::json!([0.5])),
            ("frame", serde_json::Value::Null),
        ] {
            let mut bad_value = value.clone();
            bad_value[key] = bad;
            assert!(
                serde_json::from_value::<PairingRequest>(bad_value).is_err(),
                "{key}"
            );
        }
        let duplicate = format!("{{\"relay\":\"hub\",\"relay\":\"default\",\"room\":\"{}\",\"role\":\"host\",\"expires\":{},\"operation\":\"poll\"}}", input(Operation::Poll).room, NOW + 1);
        assert!(serde_json::from_str::<PairingRequest>(&duplicate).is_err());
        for (length, allowed) in [(90028, true), (90029, false)] {
            let mut value = value.clone();
            value["operation"] = serde_json::json!("signal");
            value["frame"] = serde_json::json!(vec![255u8; length]);
            assert_eq!(
                serde_json::from_value::<PairingRequest>(value.clone()).is_ok(),
                allowed
            );
            // Parsing text exercises SeqAccess without a size hint, unlike from_value.
            assert_eq!(
                serde_json::from_str::<PairingRequest>(&value.to_string()).is_ok(),
                allowed
            );
        }
    }

    #[test]
    fn validation_covers_expiry_room_and_frame_boundaries() {
        for operation in [Operation::Start, Operation::Poll, Operation::Signal] {
            assert!(validate(&input(operation), NOW).is_ok());
        }
        for expires in [NOW, NOW - 1, NOW + 660001, u64::MAX] {
            let mut value = input(Operation::Poll);
            value.expires = expires;
            assert!(validate(&value, NOW).is_err());
        }
        for expires in [NOW + 1, NOW + 660000] {
            let mut value = input(Operation::Poll);
            value.expires = expires;
            assert!(validate(&value, NOW).is_ok());
        }
        for room in [
            "a".repeat(31),
            "a".repeat(33),
            "A".repeat(32),
            "g".repeat(32),
            "a".repeat(31) + "/",
            "a".repeat(31) + "\n",
        ] {
            let mut value = input(Operation::Poll);
            value.room = room;
            assert!(validate(&value, NOW).is_err());
        }
        for (length, allowed) in [
            (0, false),
            (28, false),
            (29, true),
            (90028, true),
            (90029, false),
        ] {
            let mut value = input(Operation::Signal);
            value.frame = Some(vec![0; length]);
            assert_eq!(validate(&value, NOW).is_ok(), allowed);
        }
        let mut value = input(Operation::Signal);
        value.frame = None;
        assert!(validate(&value, NOW).is_err());
        for operation in [Operation::Start, Operation::Poll] {
            let mut value = input(operation);
            value.frame = Some(vec![]);
            assert!(validate(&value, NOW).is_err());
        }
    }

    #[test]
    fn origin_and_url_are_canonical_and_closed() {
        for (base, expected) in [
            ("https://HUB.example:443/path", "https://hub.example"),
            ("http://127.0.0.1:3020", "http://127.0.0.1:3020"),
            ("http://localhost:3020/app", "http://localhost:3020"),
            ("http://[::1]:3020", "http://[::1]:3020"),
        ] {
            assert_eq!(hub_origin(base).unwrap(), expected);
        }
        for base in [
            "http://external.invalid",
            "http://127.0.0.2:3020",
            "https://user:secret@hub.example",
            "https://hub.example?key=secret",
            "https://hub.example#key",
            "file:///tmp/test",
            "https://hub.example\n",
            " https://hub.example",
        ] {
            assert_eq!(hub_origin(base).unwrap_err(), INPUT_ERROR);
        }
        let mut value = input(Operation::Start);
        assert_eq!(
            request_url("https://hub.example", &value).unwrap().as_str(),
            format!(
                "https://hub.example/pair/{}/host?expires={}&transport=http&action=start",
                value.room, value.expires
            )
        );
        value.operation = Operation::Poll;
        value.role = Role::Guest;
        value.relay = Relay::Default;
        assert_eq!(
            request_url("https://hub.example", &value).unwrap().as_str(),
            format!(
                "{DEFAULT_RELAY}/pair/{}/guest?expires={}&transport=http",
                value.room, value.expires
            )
        );
    }

    #[test]
    fn accumulation_and_status_boundaries() {
        let mut bytes = vec![0; MAX_FRAME_BYTES - 1];
        append_chunk(&mut bytes, b"a").unwrap();
        append_chunk(&mut bytes, b"").unwrap();
        assert_eq!(append_chunk(&mut bytes, b"b").unwrap_err(), RESPONSE_ERROR);
        assert!(append_chunk(&mut vec![], &vec![0; MAX_FRAME_BYTES + 1]).is_err());
        assert!(append_chunk(&mut vec![0; MAX_FRAME_BYTES + 1], &[]).is_err());
        for operation in [Operation::Start, Operation::Signal] {
            for status in [200, 201, 202, 301, 302, 307, 308, 401, 418] {
                assert!(!status_allowed(operation, status));
            }
        }
        for status in [
            200, 202, 204, 400, 403, 404, 405, 409, 410, 413, 429, 500, 502, 503, 504,
        ] {
            assert!(status_allowed(Operation::Poll, status));
        }
        assert_eq!(
            serde_json::to_value(PairingResponse {
                status: 204,
                frame: None
            })
            .unwrap(),
            serde_json::json!({"status":204,"frame":null})
        );
    }

    // Each server accepts one request and exits; no public relay or application state is used.
    fn server(response: Vec<u8>) -> (String, mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            tx.send(request).unwrap();
            let _ = socket.write_all(&response);
        });
        (base, rx, task)
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    fn live_input(operation: Operation) -> PairingRequest {
        let mut value = input(operation);
        value.expires = now_ms().unwrap() + 600000;
        value
    }
    fn wire(status: u16, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }
    fn roundtrip(
        operation: Operation,
        response: Vec<u8>,
    ) -> (Result<PairingResponse, String>, Vec<u8>) {
        let (base, received, task) = server(response);
        let result = runtime().block_on(request(&base, live_input(operation)));
        let bytes = received.recv_timeout(Duration::from_secs(5)).unwrap();
        task.join().unwrap();
        (result, bytes)
    }

    #[test]
    fn local_http_preserves_ciphertext_origin_and_has_no_authentication() {
        let (base, received, task) = server(wire(204, "Set-Cookie: relay=ignored\r\n", &[]));
        let mut value = live_input(Operation::Signal);
        value.frame = Some((0..=255).collect());
        let expiry = value.expires;
        assert_eq!(
            runtime()
                .block_on(request(&(base.clone() + "/configured-path"), value))
                .unwrap(),
            PairingResponse {
                status: 204,
                frame: None
            }
        );
        let bytes = received.recv_timeout(Duration::from_secs(5)).unwrap();
        task.join().unwrap();
        let end = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap();
        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
        assert!(headers.starts_with(&format!("post /pair/0123456789abcdef0123456789abcdef/host?expires={expiry}&transport=http&action=signal http/1.1")));
        assert!(headers.contains(&format!("\r\norigin: {base}")));
        assert!(headers.contains("\r\ncontent-type: application/octet-stream"));
        for name in [
            "authorization:",
            "cookie:",
            "proxy-authorization:",
            "referer:",
        ] {
            assert!(!headers.contains(name), "{name}");
        }
        assert_eq!(&bytes[end + 4..], &(0..=255).collect::<Vec<u8>>());
        for operation in [Operation::Start, Operation::Poll] {
            let (result, bytes) = roundtrip(operation, wire(204, "", &[]));
            assert!(result.is_ok());
            let end = bytes
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .unwrap();
            assert!(bytes[end + 4..].is_empty());
            assert!(!String::from_utf8_lossy(&bytes[..end])
                .to_ascii_lowercase()
                .contains("cookie:"));
        }
    }

    #[test]
    fn local_http_validates_operation_status_mime_and_error_body() {
        let frame = vec![127; 29];
        let binary = "Content-Type: application/octet-stream\r\n";
        for status in [202, 204] {
            assert_eq!(
                roundtrip(Operation::Poll, wire(status, "", &[])).0.unwrap(),
                PairingResponse {
                    status,
                    frame: None
                }
            );
        }
        assert_eq!(
            roundtrip(Operation::Poll, wire(200, binary, &frame))
                .0
                .unwrap()
                .frame,
            Some(frame.clone())
        );
        for status in [400, 403, 404, 405, 409, 410, 413, 429, 500, 502, 503, 504] {
            assert_eq!(
                roundtrip(
                    Operation::Poll,
                    wire(
                        status,
                        "Content-Type: text/plain\r\n",
                        b"private response details"
                    )
                )
                .0
                .unwrap(),
                PairingResponse {
                    status,
                    frame: None
                }
            );
        }
        for (operation, status, headers, body) in [
            (Operation::Start, 200, binary, frame.as_slice()),
            (Operation::Signal, 202, "", &[]),
            (Operation::Poll, 201, binary, frame.as_slice()),
            (Operation::Poll, 200, "", frame.as_slice()),
            (
                Operation::Poll,
                200,
                "Content-Type: text/html\r\n",
                frame.as_slice(),
            ),
            (Operation::Poll, 202, "", b"extra"),
            (
                Operation::Poll,
                200,
                "Content-Type: application/octet-stream\r\nContent-Encoding: gzip\r\n",
                frame.as_slice(),
            ),
        ] {
            assert_eq!(
                roundtrip(operation, wire(status, headers, body))
                    .0
                    .unwrap_err(),
                RESPONSE_ERROR
            );
        }
        let redirect = wire(302, "Location: /must-not-follow\r\n", &[]);
        assert_eq!(
            roundtrip(Operation::Poll, redirect).0.unwrap_err(),
            RESPONSE_ERROR
        );
        assert_eq!(
            roundtrip(Operation::Poll, vec![]).0.unwrap_err(),
            NETWORK_ERROR
        );
    }

    #[test]
    fn local_http_enforces_actual_chunked_frame_bytes_and_minimum() {
        for (length, allowed) in [(28, false), (29, true), (90028, true), (90029, false)] {
            let bytes = vec![193; length];
            let mut response=b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
            for part in bytes.chunks(11111) {
                response.extend_from_slice(format!("{:x}\r\n", part.len()).as_bytes());
                response.extend_from_slice(part);
                response.extend_from_slice(b"\r\n");
            }
            response.extend_from_slice(b"0\r\n\r\n");
            let result = roundtrip(Operation::Poll, response).0;
            if allowed {
                assert_eq!(result.unwrap().frame, Some(bytes));
            } else {
                assert_eq!(result.unwrap_err(), RESPONSE_ERROR);
            }
        }
        assert_eq!(
            roundtrip(Operation::Poll, wire(403, "", &vec![0; 90029]))
                .0
                .unwrap_err(),
            RESPONSE_ERROR
        );
    }
}
