//! Opt-in control for the bundled main shell. Replies contain closed metadata only.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};

const SAFE: u64 = 9_007_199_254_740_991;
const TIMEOUT: Duration = Duration::from_secs(10);
static ENABLED: AtomicBool = AtomicBool::new(false);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShellView { Feed, Notifications, Market, Settings, Music, Node, Search, Videos, Wallet, Ai, Articles, Threads, Research, Messages,
 #[serde(rename="saved_articles")] SavedArticles,
 #[serde(rename="video_library")] VideoLibrary,
 #[serde(rename="music_library")] MusicLibrary,
 #[serde(rename="video_playlists")] VideoPlaylists,
 #[serde(rename="music_playlists")] MusicPlaylists }
impl ShellView {
    fn contains(self, id: u8) -> bool {
        match self { Self::Feed => (1..=3).contains(&id), Self::Notifications => (4..=8).contains(&id), Self::Market => (9..=11).contains(&id), Self::Settings => (12..=15).contains(&id), Self::Music|Self::Node|Self::Search|Self::Videos|Self::Wallet|Self::Ai|Self::Articles|Self::Threads|Self::Research|Self::Messages|Self::SavedArticles|Self::VideoLibrary|Self::MusicLibrary|Self::VideoPlaylists|Self::MusicPlaylists=>false }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellLayout { pub view: ShellView, pub sidebar_open: bool, pub rail_open: bool }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellState {
    #[serde(deserialize_with = "required_view")]
    pub view: Option<ShellView>, pub sidebar_open: bool, pub rail_open: bool,
    pub sidebar_width: f64, pub rail_width: f64, pub sidebar_selected: u8,
    pub native_revision: u64, pub native_ids: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_surface: Option<AiSurface>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiSurface { Legacy, Preparing, WorkspaceRequired, Failed }
fn required_view<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ShellView>, D::Error> { Option::deserialize(d) }
impl ShellState {
    fn valid(&self) -> bool {
        let sidebar_range = if self.view == Some(ShellView::Ai) { 190.0..=8192.0 } else { 190.0..=260.0 };
        self.sidebar_width.is_finite() && sidebar_range.contains(&self.sidebar_width)
            && (self.ai_surface.is_none() || self.view == Some(ShellView::Ai))
            && self.rail_width.is_finite() && (240.0..=480.0).contains(&self.rail_width)
            && self.native_revision <= SAFE && self.native_ids.len() <= 5 && (self.native_ids.is_empty() || self.native_revision > 0)
            && (self.sidebar_selected == 0 || self.view.is_some_and(|v| v.contains(self.sidebar_selected)))
            && self.native_ids.iter().enumerate().all(|(i, id)| self.view.is_some_and(|v| v.contains(*id)) && !self.native_ids[..i].contains(id))
    }
    fn matches(&self, layout: Option<ShellLayout>) -> bool {
        self.valid() && layout.is_none_or(|l| self.view == Some(l.view) && self.sidebar_open == l.sidebar_open && self.rail_open == l.rail_open)
    }
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellOutcome { Applied, Failed, Superseded }
struct Pending { id: u64, layout: Option<ShellLayout>, deadline: Instant, sender: Option<mpsc::SyncSender<Result<ShellState, String>>> }
struct Ticket<'a> { slot: &'a Mutex<Option<Pending>>, id: u64, deadline: Instant, receiver: mpsc::Receiver<Result<ShellState, String>> }
impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if slot.as_ref().is_some_and(|p| p.id == self.id) { *slot = None; }
    }
}

/// Call only from desktop_control::start, after the exact --control-stdio gate.
pub fn enable_control() { ENABLED.store(true, Ordering::SeqCst); }
pub fn is_pending() -> bool { PENDING.lock().map_or(true, |slot| slot.is_some()) }
fn begin<'a>(slot: &'a Mutex<Option<Pending>>, sequence: &AtomicU64, enabled: bool, busy: bool, layout: Option<ShellLayout>, deadline: Instant) -> Result<Ticket<'a>, String> {
    if !enabled { return Err("shell_control_forbidden".into()); }
    if busy { return Err("shell_control_busy".into()); }
    if Instant::now() >= deadline { return Err("shell_control_timeout".into()); }
    let mut pending = slot.lock().map_err(|_| "shell_control_unavailable")?;
    if pending.is_some() { return Err("shell_control_busy".into()); }
    let id = sequence.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1).filter(|n| *n <= SAFE)).map(|n| n+1).map_err(|_| "shell_control_exhausted")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    *pending = Some(Pending { id, layout, deadline, sender: Some(sender) });
    Ok(Ticket { slot, id, deadline, receiver })
}
fn complete(slot: &Mutex<Option<Pending>>, enabled: bool, label: &str, id: u64, outcome: ShellOutcome, state: Option<ShellState>, now: Instant) -> Result<(), String> {
    if !enabled || label != "main" { return Err("shell_control_forbidden".into()); }
    if id == 0 || id > SAFE { return Err("shell_control_invalid".into()); }
    let mut pending = slot.lock().map_err(|_| "shell_control_unavailable")?;
    let p = pending.as_mut().filter(|p| p.id == id).ok_or("shell_control_invalid")?;
    if now >= p.deadline { *pending = None; return Err("shell_control_expired".into()); }
    let result = match (outcome, state) {
        (ShellOutcome::Applied, Some(state)) if state.matches(p.layout) => Ok(state),
        (ShellOutcome::Failed, None) => Err("shell_control_failed".into()),
        (ShellOutcome::Superseded, None) => Err("shell_control_superseded".into()),
        _ => return Err("shell_control_invalid".into()),
    };
    p.sender.take().ok_or("shell_control_invalid")?.try_send(result).map_err(|_| "shell_control_unavailable".into())
}
#[tauri::command]
pub fn shell_control_ack(webview: tauri::Webview, request_id: u64, outcome: ShellOutcome, state: Option<ShellState>) -> Result<(), String> {
    complete(&PENDING, ENABLED.load(Ordering::SeqCst), webview.label(), request_id, outcome, state, Instant::now())
}
fn expiry(now: Instant, wall: SystemTime, deadline: Instant) -> Result<u64, String> {
    let remaining = deadline.checked_duration_since(now).filter(|d| !d.is_zero()).ok_or("shell_control_timeout")?;
    expiry_millis(wall.duration_since(UNIX_EPOCH).map_err(|_| "shell_control_unavailable")?.as_millis(), remaining)
}
fn expiry_millis(wall_ms: u128, remaining: Duration) -> Result<u64, String> {
    wall_ms.checked_add(remaining.as_millis()).and_then(|n| u64::try_from(n).ok())
        .filter(|n| *n > 0 && *n <= SAFE).ok_or("shell_control_unavailable".into())
}
fn wait(ticket: &Ticket<'_>) -> Result<ShellState, String> {
    let remaining = ticket.deadline.checked_duration_since(Instant::now()).ok_or("shell_control_timeout")?;
    let result = ticket.receiver.recv_timeout(remaining);
    if Instant::now() >= ticket.deadline { return Err("shell_control_timeout".into()); }
    result.map_err(|e| match e { mpsc::RecvTimeoutError::Timeout => "shell_control_timeout", mpsc::RecvTimeoutError::Disconnected => "shell_control_unavailable" })?
}
pub fn dispatch(app: &AppHandle, layout: Option<ShellLayout>, busy: bool) -> Result<Value, String> {
    let deadline = Instant::now().checked_add(TIMEOUT).ok_or("shell_control_unavailable")?;
    let ticket = begin(&PENDING, &SEQUENCE, ENABLED.load(Ordering::SeqCst), busy, layout, deadline)?;
    let handle = app.clone(); let id = ticket.id; let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result: Result<(), String> = (|| {
            if !ENABLED.load(Ordering::SeqCst) { return Err("shell_control_forbidden".into()); }
            if !PENDING.lock().map_err(|_| "shell_control_unavailable")?.as_ref().is_some_and(|p| p.id == id) { return Err("shell_control_expired".into()); }
            let expires_at = expiry(Instant::now(), SystemTime::now(), deadline)?;
            if Instant::now() >= deadline { return Err("shell_control_timeout".into()); }
            handle.emit_to("main", "shell-control", json!({"requestId":id,"expiresAt":expires_at,"layout":layout})).map_err(|_| "shell_control_dispatch_failed".into())
        })();
        let _ = tx.try_send(result);
    }).map_err(|_| "shell_control_dispatch_failed")?;
    rx.recv_timeout(deadline.checked_duration_since(Instant::now()).ok_or("shell_control_timeout")?).map_err(|_| "shell_control_timeout")??;
    serde_json::to_value(wait(&ticket)?).map_err(|_| "shell_control_unavailable".into())
}

#[cfg(test)]
mod tests {
    #[test] fn messages_view_is_readonly() { let view:ShellView=serde_json::from_value(json!("messages")).unwrap(); assert_eq!(view,ShellView::Messages); assert!((0..=u8::MAX).all(|id|!view.contains(id))); }
    #[test] fn research_view_is_readonly() { let view:ShellView=serde_json::from_value(json!("research")).unwrap(); assert_eq!(view,ShellView::Research); assert!((0..=u8::MAX).all(|id|!view.contains(id))); }
    use super::*;
    fn state() -> ShellState { ShellState { view:Some(ShellView::Feed),sidebar_open:true,rail_open:false,sidebar_width:190.0,rail_width:240.0,sidebar_selected:1,native_revision:0,native_ids:vec![],ai_surface:None } }
    fn deadline() -> Instant { Instant::now()+TIMEOUT }
    #[test] fn closed_shapes_and_types() {
        let layout = r#"{"view":"feed","sidebarOpen":true,"railOpen":false}"#;
        assert!(serde_json::from_str::<ShellLayout>(layout).is_ok());
        for s in [layout.replace("feed","browser"),layout.replace("true","1"),layout.replace("}",",\"extra\":0}"),layout.replace("railOpen","rail_open")] { assert!(serde_json::from_str::<ShellLayout>(&s).is_err()); }
        let good=serde_json::to_value(state()).unwrap(); assert!(serde_json::from_value::<ShellState>(good.clone()).unwrap().valid());
        let mut missing=good.clone();missing.as_object_mut().unwrap().remove("view");assert!(serde_json::from_value::<ShellState>(missing).is_err());
        let mut extra=good.clone();extra["title"]=json!("not allowed");assert!(serde_json::from_value::<ShellState>(extra).is_err());
        for field in ["sidebarOpen","railOpen"] { let mut v=good.clone();v[field]=json!(1);assert!(serde_json::from_value::<ShellState>(v).is_err()); }
        for value in [json!(-1),json!(256),json!(1.5)] { let mut v=good.clone();v["sidebarSelected"]=value;assert!(serde_json::from_value::<ShellState>(v).is_err()); }
    }
    #[test] fn fixed_product_screens_have_no_native_action_ids() {
        for name in ["search","videos","wallet","ai","articles","threads"] {
            let layout:ShellLayout=serde_json::from_value(json!({"view":name,"sidebarOpen":true,"railOpen":false})).unwrap();
            let mut s=state();s.view=Some(layout.view);s.sidebar_selected=0;assert!(s.valid());
            s.sidebar_selected=1;assert!(!s.valid());s.sidebar_selected=0;s.native_revision=1;s.native_ids=vec![1];assert!(!s.valid());
        }
    }
    #[test] fn ai_surface_is_optional_typed_metadata_without_changing_legacy_shape_or_width() {
        let old=serde_json::to_value(state()).unwrap();assert_eq!(old.as_object().unwrap().len(),8);assert!(serde_json::from_value::<ShellState>(old.clone()).unwrap().valid());
        let mut nullable=old.clone();nullable["aiSurface"]=Value::Null;assert!(serde_json::from_value::<ShellState>(nullable).unwrap().valid());
        let mut ai=state();ai.view=Some(ShellView::Ai);ai.sidebar_selected=0;
        for (surface,name) in [(AiSurface::Legacy,"legacy"),(AiSurface::Preparing,"preparing"),(AiSurface::WorkspaceRequired,"workspace_required"),(AiSurface::Failed,"failed")] {
            ai.ai_surface=Some(surface);assert!(ai.valid());let serialized=serde_json::to_value(&ai).unwrap();assert_eq!(serialized.as_object().unwrap().len(),9);assert_eq!(serialized["aiSurface"],json!(name));
            assert_eq!(serde_json::from_value::<ShellState>(serialized).unwrap().ai_surface,Some(surface));
            let mut feed=state();feed.ai_surface=Some(surface);assert!(!feed.valid());
        }
        let mut base=serde_json::to_value(&ai).unwrap();
        for value in [json!("t3"),json!("T3"),json!("unknown"),json!(""),json!(false),json!(1),json!({}),json!([])] { base["aiSurface"]=value;assert!(serde_json::from_value::<ShellState>(base.clone()).is_err()); }
        base["aiSurface"]=json!("legacy");base["unexpected"]=json!(true);assert!(serde_json::from_value::<ShellState>(base).is_err());
        for width in [190.0,208.0,8192.0] {ai.sidebar_width=width;assert!(ai.valid());}
        for width in [189.999,8192.001,f64::NAN,f64::INFINITY] {ai.sidebar_width=width;assert!(!ai.valid());}
    }
    #[test] fn ai_width_is_bounded_without_enabling_native_sidebar_ids() {
        let mut ai=state();ai.view=Some(ShellView::Ai);ai.sidebar_selected=0;ai.native_ids.clear();
        for width in [190.0,198.0,207.999,208.0,208.5,260.0,260.5,8192.0] { ai.sidebar_width=width;assert!(ai.valid()); }
        for width in [189.999,8192.001,f64::NAN,f64::INFINITY,f64::NEG_INFINITY] { ai.sidebar_width=width;assert!(!ai.valid()); }
        for width in [190.0,208.0,8192.0] { ai.sidebar_width=width;ai.sidebar_selected=1;assert!(!ai.valid());ai.sidebar_selected=0;ai.native_revision=1;ai.native_ids=vec![1];assert!(!ai.valid());ai.native_ids.clear(); }
        for view in [Some(ShellView::Feed),Some(ShellView::Notifications),Some(ShellView::Market),Some(ShellView::Settings),Some(ShellView::Wallet),None] {
            let mut other=state();other.view=view;other.sidebar_selected=0;
            for width in [190.0,198.0,208.0,260.0] { other.sidebar_width=width;assert!(other.valid()); }
            for width in [189.999,260.001,8192.0,f64::NAN,f64::INFINITY] { other.sidebar_width=width;assert!(!other.valid()); }
        }
    }
    #[test] fn metadata_width_views_ids_and_safe_integer_edges() {
        let mut s=state();s.sidebar_width=260.0;s.rail_width=480.0;s.native_revision=SAFE;assert!(s.valid());
        for width in [189.999,260.001,f64::NAN,f64::INFINITY] { let mut v=s.clone();v.sidebar_width=width;assert!(!v.valid()); }
        for width in [239.999,480.001,f64::NAN] { let mut v=s.clone();v.rail_width=width;assert!(!v.valid()); }
        s.native_revision=SAFE+1;assert!(!s.valid());s.native_revision=1;
        let mut zero_revision=state();zero_revision.native_ids=vec![1];assert!(!zero_revision.valid());
        for (view,ids) in [(ShellView::Feed,vec![1,2,3]),(ShellView::Notifications,vec![4,5,6,7,8]),(ShellView::Market,vec![9,10,11]),(ShellView::Settings,vec![12,13,14,15])] { s.view=Some(view);s.sidebar_selected=ids[0];s.native_ids=ids;assert!(s.valid());s.native_ids.push(s.native_ids[0]);assert!(!s.valid()); }
        s.view=None;s.sidebar_selected=0;s.native_ids.clear();assert!(s.valid());s.native_ids=vec![1];assert!(!s.valid());s.native_ids.clear();s.sidebar_selected=1;assert!(!s.valid());
        for ids in [vec![0],vec![16],vec![4],vec![1,1],vec![1,2,3,1,2,3]] { let mut s=state();s.native_ids=ids;assert!(!s.valid()); }
    }
    #[test] fn gate_busy_drop_and_exhaustion() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(0);
        assert!(begin(&slot,&sequence,false,false,None,deadline()).is_err());assert!(begin(&slot,&sequence,true,true,None,deadline()).is_err());assert!(begin(&slot,&sequence,true,false,None,Instant::now()).is_err());
        let a=begin(&slot,&sequence,true,false,None,deadline()).unwrap();assert_eq!(a.id,1);assert!(begin(&slot,&sequence,true,false,None,deadline()).is_err());drop(a);assert!(slot.lock().unwrap().is_none());
        sequence.store(SAFE-1,Ordering::SeqCst);assert_eq!(begin(&slot,&sequence,true,false,None,deadline()).unwrap().id,SAFE);assert!(begin(&slot,&sequence,true,false,None,deadline()).is_err());sequence.store(u64::MAX,Ordering::SeqCst);assert!(begin(&slot,&sequence,true,false,None,deadline()).is_err());
    }
    #[test] fn matching_main_ack_once_and_negative_result() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(0);let ticket=begin(&slot,&sequence,true,false,None,deadline()).unwrap();
        for (enabled,label,id) in [(false,"main",ticket.id),(true,"child",ticket.id),(true,"main",0),(true,"main",SAFE+1),(true,"main",ticket.id+1)] { assert!(complete(&slot,enabled,label,id,ShellOutcome::Applied,Some(state()),Instant::now()).is_err()); }
        assert!(complete(&slot,true,"main",ticket.id,ShellOutcome::Failed,Some(state()),Instant::now()).is_err());
        complete(&slot,true,"main",ticket.id,ShellOutcome::Applied,Some(state()),Instant::now()).unwrap();assert!(complete(&slot,true,"main",ticket.id,ShellOutcome::Applied,Some(state()),Instant::now()).is_err());assert_eq!(wait(&ticket).unwrap(),state());drop(ticket);
        for (outcome,code) in [(ShellOutcome::Failed,"shell_control_failed"),(ShellOutcome::Superseded,"shell_control_superseded")] { let ticket=begin(&slot,&sequence,true,false,None,deadline()).unwrap();complete(&slot,true,"main",ticket.id,outcome,None,Instant::now()).unwrap();assert_eq!(wait(&ticket).unwrap_err(),code); }
    }
    #[test] fn requested_layout_and_expiry_do_not_admit_mismatch() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(0);let layout=ShellLayout{view:ShellView::Feed,sidebar_open:true,rail_open:false};let ticket=begin(&slot,&sequence,true,false,Some(layout),deadline()).unwrap();
        let mut wrong=state();wrong.rail_open=true;assert!(complete(&slot,true,"main",ticket.id,ShellOutcome::Applied,Some(wrong),Instant::now()).is_err());
        let mut wrong=state();wrong.view=Some(ShellView::Settings);wrong.sidebar_selected=12;assert!(complete(&slot,true,"main",ticket.id,ShellOutcome::Applied,Some(wrong),Instant::now()).is_err());
        assert!(complete(&slot,true,"main",ticket.id,ShellOutcome::Applied,Some(state()),ticket.deadline).is_err());assert!(slot.lock().unwrap().is_none());
        assert_eq!(expiry_millis((SAFE-10) as u128,Duration::from_millis(10)).unwrap(),SAFE);
        assert_eq!(expiry_millis(SAFE as u128,Duration::ZERO).unwrap(),SAFE);
        assert!(expiry_millis((SAFE+1) as u128,Duration::ZERO).is_err());
        assert!(expiry_millis((SAFE-10) as u128,Duration::from_millis(11)).is_err());
        assert!(expiry_millis(u128::MAX,Duration::from_millis(1)).is_err());
        assert!(expiry_millis(0,Duration::ZERO).is_err());
        let now=Instant::now();let wall=UNIX_EPOCH+Duration::from_secs(1);
        assert_eq!(expiry(now,wall,now+Duration::from_millis(10)).unwrap(),1010);
        assert!(expiry(now,UNIX_EPOCH-Duration::from_secs(1),now+TIMEOUT).is_err());
        assert!(expiry(now,wall,now).is_err());
        assert!(expiry(now,wall,now-Duration::from_millis(1)).is_err());
    }
    #[test] fn stale_ticket_drop_cannot_clear_new_pending() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(0);let ticket=begin(&slot,&sequence,true,false,None,deadline()).unwrap();
        let (sender,_)=mpsc::sync_channel(1);*slot.lock().unwrap()=Some(Pending{id:ticket.id+1,layout:None,deadline:deadline(),sender:Some(sender)});drop(ticket);assert_eq!(slot.lock().unwrap().as_ref().unwrap().id,2);
    }
}
