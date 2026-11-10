//! 右列のリアルタイム（グループ・DMの新着）。docs/hub-groups/DESIGN.md「サーバーの口 1」。
//!
//! 端末の認証（desktop assertion）はこのファイルの `HubTransport::ticket` の中だけで使い、
//! WebSocket にはワンタイムのチケットしか載せない。窓へ渡すのは id だけのイベント
//! （本文・チケット・URL・エラー文は渡さない・ログにも出さない）。切れたら新しいチケットで
//! 指数バックオフで繋ぎ直し、繋がっていない間は窓側が従来のポーリングに戻る。

use serde::Serialize;
use std::future::Future;
use std::time::Duration;
use tokio::sync::watch;

pub const TICKET_PATH: &str = "/api/client/realtime/ticket";
pub const LIVE_PATH: &str = "/api/client/realtime/live";
pub const MAX_COMMUNITIES: usize = 8;
/// 続けて繋がらなかったらあきらめて窓へ「failed」を返す（窓は定期取得のまま）。
pub const MAX_CONSECUTIVE_FAILURES: u32 = 6;
const MAX_FRAME_BYTES: usize = 4096;
const MAX_TICKET_LEN: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Topics {
    pub communities: Vec<String>,
    pub dm: bool,
}

fn member_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn validate_topics(communities: Vec<String>, dm: bool) -> Result<Topics, String> {
    if communities.len() > MAX_COMMUNITIES || !communities.iter().all(|id| member_id(id)) {
        return Err("realtime_invalid_topics".into());
    }
    let mut unique: Vec<String> = Vec::new();
    for id in communities { if !unique.contains(&id) { unique.push(id); } }
    if unique.is_empty() && !dm { return Err("realtime_invalid_topics".into()); }
    Ok(Topics { communities: unique, dm })
}

/// 窓へ渡すイベント。フィールドはこの定義にあるものだけ。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    GroupMessage { community_id: String, message_id: String, ordinal: i64, at: String },
    #[serde(rename_all = "camelCase")]
    DmMessage { conversation_id: String, cursor: i64, at: String },
}

fn short_text(value: Option<&serde_json::Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)).then(|| text.to_owned())
}
fn counter(value: Option<&serde_json::Value>) -> Option<i64> {
    let n = value?.as_i64()?;
    (0..=9_007_199_254_740_991).contains(&n).then_some(n)
}

/// 受け取った1フレームを、購読中の話題の id だけのイベントにする。形が違う・話題外・余分な項目は捨てる（余分は無視）。
pub fn parse_event(text: &str, topics: &Topics) -> Option<Event> {
    if text.len() > MAX_FRAME_BYTES { return None; }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let at = short_text(value.get("at"), 40)?;
    match value.get("type")?.as_str()? {
        "group-message" => {
            let community_id = short_text(value.get("communityId"), 100)?;
            if !member_id(&community_id) || !topics.communities.contains(&community_id) { return None; }
            let message_id = short_text(value.get("messageId"), 100)?;
            if !member_id(&message_id) { return None; }
            Some(Event::GroupMessage { community_id, message_id, ordinal: counter(value.get("ordinal"))?, at })
        }
        "dm-message" if topics.dm => {
            let conversation_id = short_text(value.get("conversationId"), 100)?;
            if !member_id(&conversation_id) { return None; }
            Some(Event::DmMessage { conversation_id, cursor: counter(value.get("cursor"))?, at })
        }
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status { Open, Closed, Failed }
impl Status {
    pub fn as_str(self) -> &'static str { match self { Status::Open => "open", Status::Closed => "closed", Status::Failed => "failed" } }
}

#[derive(Clone, Debug)]
pub struct Timing { pub base: Duration, pub cap: Duration, pub ping_every: Duration, pub stale_after: Duration }
impl Default for Timing {
    fn default() -> Self {
        Self { base: Duration::from_secs(1), cap: Duration::from_secs(60), ping_every: Duration::from_secs(25), stale_after: Duration::from_secs(75) }
    }
}
/// 1秒、2秒、4秒…を上限まで。attempt は 1 から。
pub fn backoff(attempt: u32, timing: &Timing) -> Duration {
    let shift = attempt.saturating_sub(1).min(16);
    timing.base.saturating_mul(1u32 << shift).min(timing.cap)
}

pub enum TicketError { Fatal, Retry }
pub enum Frame { Text(String), Other, Closed }

pub trait Socket: Send {
    fn recv(&mut self) -> impl Future<Output = Frame> + Send;
    fn ping(&mut self) -> impl Future<Output = bool> + Send;
}
pub trait Transport: Send + Sync {
    type Sock: Socket;
    fn ticket(&self, topics: &Topics) -> impl Future<Output = Result<String, TicketError>> + Send;
    fn connect(&self, ticket: &str) -> impl Future<Output = Result<Self::Sock, ()>> + Send;
}
pub trait Sink: Send + Sync {
    fn event(&self, event: Event);
    fn status(&self, status: Status);
}

async fn wait(cancel: &mut watch::Receiver<bool>, delay: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        _ = cancel.changed() => true,
    }
}

/// 繋ぐ→読む→切れたら待って繋ぎ直す。cancel が立ったら（右列が隠れた・グループが閉じた）すぐ止まる。
pub async fn run<T: Transport, S: Sink>(transport: &T, sink: &S, topics: Topics, mut cancel: watch::Receiver<bool>, timing: Timing) {
    let mut failures: u32 = 0;
    loop {
        if *cancel.borrow() { return; }
        let ticket = tokio::select! { got = transport.ticket(&topics) => got, _ = cancel.changed() => return };
        let socket = match ticket {
            Err(TicketError::Fatal) => { sink.status(Status::Failed); return; }
            Err(TicketError::Retry) => None,
            Ok(ticket) => tokio::select! { got = transport.connect(&ticket) => got.ok(), _ = cancel.changed() => return },
        };
        match socket {
            None => {
                failures += 1;
                if failures >= MAX_CONSECUTIVE_FAILURES { sink.status(Status::Failed); return; }
                if wait(&mut cancel, backoff(failures, &timing)).await { return; }
            }
            Some(mut socket) => {
                failures = 0;
                sink.status(Status::Open);
                let mut last_heard = tokio::time::Instant::now();
                let mut next_ping = last_heard + timing.ping_every;
                loop {
                    let until = next_ping.min(last_heard + timing.stale_after);
                    tokio::select! {
                        _ = cancel.changed() => { sink.status(Status::Closed); return; }
                        _ = tokio::time::sleep_until(until) => {
                            if last_heard.elapsed() >= timing.stale_after { break; }
                            if !socket.ping().await { break; }
                            next_ping = tokio::time::Instant::now() + timing.ping_every;
                        }
                        frame = socket.recv() => match frame {
                            Frame::Text(text) => {
                                last_heard = tokio::time::Instant::now();
                                if let Some(event) = parse_event(&text, &topics) { sink.event(event); }
                            }
                            Frame::Other => { last_heard = tokio::time::Instant::now(); }
                            Frame::Closed => break,
                        },
                    }
                }
                sink.status(Status::Closed);
                // 切れた直後は短く待ち、新しいチケットで繋ぎ直す。
                failures = 1;
                if wait(&mut cancel, backoff(failures, &timing)).await { return; }
            }
        }
    }
}

// --- 本物の接続（Hub） ---

pub struct HubTransport { pub base: String }

pub struct WsSocket(tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>);

impl Socket for WsSocket {
    fn recv(&mut self) -> impl Future<Output = Frame> + Send {
        use futures_util::StreamExt;
        async move {
            match self.0.next().await {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => Frame::Text(text.as_str().to_owned()),
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | Some(Err(_)) | None => Frame::Closed,
                Some(Ok(_)) => Frame::Other,
            }
        }
    }
    fn ping(&mut self) -> impl Future<Output = bool> + Send {
        use futures_util::SinkExt;
        async move { self.0.send(tokio_tungstenite::tungstenite::Message::Text("ping".into())).await.is_ok() }
    }
}

/// http→ws、https→wss。パスは固定、チケットだけが問い合わせに載る。
pub fn live_url(base: &str, ticket: &str) -> Result<String, ()> {
    let rest = if let Some(rest) = base.strip_prefix("https://") { ("wss://", rest) }
        else if let Some(rest) = base.strip_prefix("http://") { ("ws://", rest) } else { return Err(()) };
    if ticket.is_empty() || ticket.len() > MAX_TICKET_LEN || !ticket.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') { return Err(()); }
    Ok(format!("{}{}{}?ticket={}", rest.0, rest.1.trim_end_matches('/'), LIVE_PATH, ticket))
}

impl Transport for HubTransport {
    type Sock = WsSocket;
    fn ticket(&self, topics: &Topics) -> impl Future<Output = Result<String, TicketError>> + Send {
        async move {
            let assertion = match crate::desktop_account::assertion_if_registered(&self.base).await {
                Ok(Some(value)) => value,
                Ok(None) => return Err(TicketError::Fatal),
                Err(_) => return Err(TicketError::Retry),
            };
            let url = format!("{}{}", self.base.trim_end_matches('/'), TICKET_PATH);
            let client = reqwest::Client::builder().timeout(Duration::from_secs(12)).redirect(reqwest::redirect::Policy::none())
                .build().map_err(|_| TicketError::Retry)?;
            let response = client.post(url).bearer_auth(assertion)
                .json(&serde_json::json!({ "communities": topics.communities, "dm": topics.dm }))
                .send().await.map_err(|_| TicketError::Retry)?;
            let status = response.status().as_u16();
            if matches!(status, 400 | 401 | 403) { return Err(TicketError::Fatal); }
            if !(200..300).contains(&status) { return Err(TicketError::Retry); }
            let body = response.bytes().await.map_err(|_| TicketError::Retry)?;
            if body.len() > 8192 { return Err(TicketError::Retry); }
            let value: serde_json::Value = serde_json::from_slice(&body).map_err(|_| TicketError::Retry)?;
            value.get("ticket").and_then(|v| v.as_str()).map(str::to_owned).ok_or(TicketError::Retry)
        }
    }
    fn connect(&self, ticket: &str) -> impl Future<Output = Result<WsSocket, ()>> + Send {
        let url = live_url(&self.base, ticket);
        async move {
            let url = url?;
            let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                .max_message_size(Some(MAX_FRAME_BYTES)).max_frame_size(Some(MAX_FRAME_BYTES));
            let connecting = tokio_tungstenite::connect_async_with_config(url, Some(config), false);
            match tokio::time::timeout(Duration::from_secs(15), connecting).await {
                Ok(Ok((stream, _))) => Ok(WsSocket(stream)),
                _ => Err(()),
            }
        }
    }
}

// --- Tauri に載せる部分 ---

#[derive(Default)]
pub struct RealtimeState(pub tokio::sync::Mutex<Option<watch::Sender<bool>>>);

impl RealtimeState {
    /// 動いている購読があれば止める。止めるだけで新しくは始めない。
    pub async fn stop(&self) {
        if let Some(cancel) = self.0.lock().await.take() { let _ = cancel.send(true); }
    }
    pub async fn replace(&self, cancel: watch::Sender<bool>) {
        let mut slot = self.0.lock().await;
        if let Some(old) = slot.replace(cancel) { let _ = old.send(true); }
    }
}

pub struct TauriSink(pub tauri::AppHandle);
impl Sink for TauriSink {
    fn event(&self, event: Event) { use tauri::Emitter; let _ = self.0.emit("hub-realtime", event); }
    fn status(&self, status: Status) { use tauri::Emitter; let _ = self.0.emit("hub-realtime-status", serde_json::json!({ "state": status.as_str() })); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    fn topics() -> Topics { validate_topics(vec!["c1".into()], true).unwrap() }
    fn quick() -> Timing { Timing { base: Duration::from_millis(5), cap: Duration::from_millis(40), ping_every: Duration::from_millis(30), stale_after: Duration::from_millis(500) } }

    #[test]
    fn topics_are_validated() {
        assert!(validate_topics(vec![], false).is_err());
        assert!(validate_topics(vec!["a b".into()], false).is_err());
        assert!(validate_topics((0..9).map(|i| format!("c{i}")).collect(), false).is_err());
        assert_eq!(validate_topics(vec!["a".into(), "a".into()], false).unwrap().communities, vec!["a".to_owned()]);
        assert!(validate_topics(vec![], true).is_ok());
    }

    #[test]
    fn only_id_fields_are_forwarded() {
        let t = topics();
        let group = r#"{"type":"group-message","communityId":"c1","messageId":"m1","ordinal":7,"at":"2026-11-06T00:00:00Z","body":"secret","extra":{"x":1}}"#;
        let event = parse_event(group, &t).unwrap();
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json, serde_json::json!({"type":"group-message","communityId":"c1","messageId":"m1","ordinal":7,"at":"2026-11-06T00:00:00Z"}));
        let dm = parse_event(r#"{"type":"dm-message","conversationId":"d1","cursor":3,"at":"x","text":"hi"}"#, &t).unwrap();
        assert_eq!(serde_json::to_value(&dm).unwrap(), serde_json::json!({"type":"dm-message","conversationId":"d1","cursor":3,"at":"x"}));
    }

    #[test]
    fn foreign_or_malformed_frames_are_dropped() {
        let t = topics();
        assert!(parse_event("pong", &t).is_none());
        assert!(parse_event(r#"{"type":"group-message","communityId":"other","messageId":"m","ordinal":1,"at":"x"}"#, &t).is_none());
        assert!(parse_event(r#"{"type":"group-message","communityId":"c1","messageId":"m","ordinal":-1,"at":"x"}"#, &t).is_none());
        assert!(parse_event(r#"{"type":"group-message","communityId":"c1","messageId":"m/../","ordinal":1,"at":"x"}"#, &t).is_none());
        assert!(parse_event(r#"{"type":"unknown","at":"x"}"#, &t).is_none());
        let no_dm = validate_topics(vec!["c1".into()], false).unwrap();
        assert!(parse_event(r#"{"type":"dm-message","conversationId":"d1","cursor":3,"at":"x"}"#, &no_dm).is_none());
        assert!(parse_event(&"x".repeat(5000), &t).is_none());
    }

    #[test]
    fn backoff_doubles_then_caps() {
        let t = Timing::default();
        let secs: Vec<u64> = (1..=8).map(|n| backoff(n, &t).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(backoff(u32::MAX, &t).as_secs(), 60);
    }

    #[test]
    fn live_url_carries_only_the_ticket() {
        assert_eq!(live_url("https://hub.example/", "ab_c-1").unwrap(), "wss://hub.example/api/client/realtime/live?ticket=ab_c-1");
        assert_eq!(live_url("http://localhost:3020", "t").unwrap(), "ws://localhost:3020/api/client/realtime/live?ticket=t");
        assert!(live_url("https://h", "a&b=c").is_err());
        assert!(live_url("ftp://h", "t").is_err());
    }

    // --- 偽の接続 ---
    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<String>>>);
    impl Log { fn push(&self, s: impl Into<String>) { self.0.lock().unwrap().push(s.into()); } fn all(&self) -> Vec<String> { self.0.lock().unwrap().clone() } }
    struct FakeSink(Log);
    impl Sink for FakeSink {
        fn event(&self, event: Event) { self.0.push(format!("event:{}", serde_json::to_string(&event).unwrap())); }
        fn status(&self, status: Status) { self.0.push(format!("status:{}", status.as_str())); }
    }
    struct FakeSock { frames: VecDeque<Frame>, hang: bool, log: Log }
    impl Socket for FakeSock {
        fn recv(&mut self) -> impl Future<Output = Frame> + Send {
            async move {
                match self.frames.pop_front() {
                    Some(frame) => frame,
                    None if self.hang => std::future::pending().await,
                    None => Frame::Closed,
                }
            }
        }
        fn ping(&mut self) -> impl Future<Output = bool> + Send { self.log.push("ping"); async { true } }
    }
    struct FakeTransport { tickets: Mutex<VecDeque<Result<String, bool>>>, socks: Mutex<VecDeque<Option<(Vec<Frame>, bool)>>>, log: Log }
    impl Transport for FakeTransport {
        type Sock = FakeSock;
        fn ticket(&self, _: &Topics) -> impl Future<Output = Result<String, TicketError>> + Send {
            self.log.push("ticket");
            let next = self.tickets.lock().unwrap().pop_front().unwrap_or(Err(false));
            async move { next.map_err(|fatal| if fatal { TicketError::Fatal } else { TicketError::Retry }) }
        }
        fn connect(&self, ticket: &str) -> impl Future<Output = Result<FakeSock, ()>> + Send {
            self.log.push(format!("connect:{ticket}"));
            let next = self.socks.lock().unwrap().pop_front().flatten();
            let log = self.log.clone();
            async move { next.map(|(frames, hang)| FakeSock { frames: frames.into(), hang, log }).ok_or(()) }
        }
    }
    fn transport(tickets: Vec<Result<&str, bool>>, socks: Vec<Option<(Vec<Frame>, bool)>>, log: &Log) -> FakeTransport {
        FakeTransport { tickets: Mutex::new(tickets.into_iter().map(|t| t.map(str::to_owned)).collect()), socks: Mutex::new(socks.into()), log: log.clone() }
    }

    #[tokio::test]
    async fn forwards_only_ids_and_reconnects_with_a_fresh_ticket() {
        let log = Log::default();
        let first = vec![
            Frame::Text(r#"{"type":"group-message","communityId":"c1","messageId":"m1","ordinal":1,"at":"x","body":"hidden"}"#.into()),
            Frame::Text("pong".into()),
            Frame::Closed,
        ];
        let second = vec![Frame::Text(r#"{"type":"dm-message","conversationId":"d1","cursor":2,"at":"y"}"#.into())];
        let t = transport(vec![Ok("t1"), Ok("t2")], vec![Some((first, false)), Some((second, true))], &log);
        let (tx, rx) = watch::channel(false);
        let sink = FakeSink(log.clone());
        let handle = tokio::spawn(async move { run(&t, &sink, topics(), rx, quick()).await; });
        tokio::time::sleep(Duration::from_millis(120)).await;
        tx.send(true).unwrap();
        handle.await.unwrap();
        let all = log.all();
        let joined = all.join("|");
        assert!(joined.contains("connect:t1") && joined.contains("connect:t2"), "{joined}");
        assert!(!joined.contains("hidden") && !joined.contains("pong"));
        assert!(all.iter().any(|l| l == r#"event:{"type":"group-message","communityId":"c1","messageId":"m1","ordinal":1,"at":"x"}"#));
        assert!(all.iter().any(|l| l.starts_with("event:") && l.contains("dm-message")));
        let statuses: Vec<&String> = all.iter().filter(|l| l.starts_with("status:")).collect();
        assert_eq!(statuses.first().unwrap().as_str(), "status:open");
        assert_eq!(statuses.last().unwrap().as_str(), "status:closed");
    }

    #[tokio::test]
    async fn fatal_ticket_failure_stops_without_retry() {
        let log = Log::default();
        let t = transport(vec![Err(true)], vec![], &log);
        let (_tx, rx) = watch::channel(false);
        run(&t, &FakeSink(log.clone()), topics(), rx, quick()).await;
        assert_eq!(log.all(), vec!["ticket", "status:failed"]);
    }

    #[tokio::test]
    async fn repeated_failures_back_off_then_give_up() {
        let log = Log::default();
        let t = transport(vec![Err(false); MAX_CONSECUTIVE_FAILURES as usize + 2], vec![], &log);
        let (_tx, rx) = watch::channel(false);
        let started = std::time::Instant::now();
        run(&t, &FakeSink(log.clone()), topics(), rx, quick()).await;
        let all = log.all();
        assert_eq!(all.iter().filter(|l| *l == "ticket").count(), MAX_CONSECUTIVE_FAILURES as usize);
        assert_eq!(all.last().unwrap(), "status:failed");
        // 5,10,20,40,40 ミリ秒 = 115ms 以上待っている。
        assert!(started.elapsed() >= Duration::from_millis(100));
    }

    #[tokio::test]
    async fn closes_promptly_when_cancelled_while_open() {
        let log = Log::default();
        let t = transport(vec![Ok("t1")], vec![Some((vec![], true))], &log);
        let (tx, rx) = watch::channel(false);
        let sink = FakeSink(log.clone());
        let handle = tokio::spawn(async move { run(&t, &sink, topics(), rx, Timing { ping_every: Duration::from_secs(60), stale_after: Duration::from_secs(120), ..quick() }).await; });
        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_millis(200), handle).await.unwrap().unwrap();
        let all = log.all();
        assert_eq!(all.iter().filter(|l| *l == "ticket").count(), 1);
        assert_eq!(all.last().unwrap(), "status:closed");
    }

    #[tokio::test]
    async fn cancel_during_backoff_does_not_reconnect() {
        let log = Log::default();
        let t = transport(vec![Err(false), Ok("never")], vec![], &log);
        let (tx, rx) = watch::channel(false);
        let sink = FakeSink(log.clone());
        let handle = tokio::spawn(async move { run(&t, &sink, topics(), rx, Timing { base: Duration::from_secs(30), cap: Duration::from_secs(30), ..quick() }).await; });
        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_millis(200), handle).await.unwrap().unwrap();
        assert_eq!(log.all(), vec!["ticket"]);
    }

    #[tokio::test]
    async fn pings_while_idle() {
        let log = Log::default();
        let t = transport(vec![Ok("t1")], vec![Some((vec![], true))], &log);
        let (tx, rx) = watch::channel(false);
        let sink = FakeSink(log.clone());
        let handle = tokio::spawn(async move { run(&t, &sink, topics(), rx, quick()).await; });
        tokio::time::sleep(Duration::from_millis(100)).await;
        tx.send(true).unwrap();
        handle.await.unwrap();
        assert!(log.all().iter().any(|l| l == "ping"));
    }

    #[tokio::test]
    async fn replacing_a_subscription_cancels_the_old_one() {
        let state = RealtimeState::default();
        let (a, mut a_rx) = watch::channel(false);
        state.replace(a).await;
        let (b, _b_rx) = watch::channel(false);
        state.replace(b).await;
        assert!(a_rx.changed().await.is_ok() && *a_rx.borrow());
        state.stop().await;
        assert!(state.0.lock().await.is_none());
    }
}
