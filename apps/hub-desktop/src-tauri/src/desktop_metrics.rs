//! Numeric-only, opt-in developer observations; no page content or storage.
use std::{cell::Cell, sync::{Mutex, OnceLock, mpsc, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}, thread::ThreadId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
enum Name { ModuleReady, UiWired, StartupComplete, FeedReady, FeedApplied, FeedSuperseded, FeedFailed, Workspace, Agents, Attach, LastSession, Feed, Node, Games, BrowserFetch, BrowserRender, BrowserRefresh, FeedReadyWait, FeedLocal, FeedConnected, FeedDistributed, FeedFederated, LastSessionRead, HistoryRender, WorkHistory }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Phase { name: Name, calls: u64, total_ms: f64, busy_ms: f64, #[serde(default, skip_serializing_if="Option::is_none")] in_flight: Option<u64> }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Mark { name: Name, at_ms: f64 }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot { elapsed_ms: f64, phases: Vec<Phase>, marks: Vec<Mark> }

impl Snapshot {
    fn valid(&self) -> bool {
        let time = |ms: f64| ms.is_finite() && (0.0..=86_400_000.0).contains(&ms);
        let mark = |name| matches!(name,Name::ModuleReady|Name::UiWired|Name::StartupComplete|Name::FeedReady|Name::FeedApplied|Name::FeedSuperseded|Name::FeedFailed);
        time(self.elapsed_ms) && self.phases.len()<=24 && self.marks.len()<=24
            && self.phases.iter().enumerate().all(|(i,p)| time(p.total_ms) && time(p.busy_ms) && p.busy_ms<=self.elapsed_ms && p.calls<=1_000_000 && p.in_flight.is_none_or(|active| active<=p.calls && active<=1_000_000)
                && !mark(p.name)
                && !self.phases[..i].iter().any(|q|p.name==q.name))
            && self.marks.iter().enumerate().all(|(i,m)| time(m.at_ms) && m.at_ms<=self.elapsed_ms
                && mark(m.name)
                && !self.marks[..i].iter().any(|q|m.name==q.name))
    }
}

static NEXT: AtomicU64 = AtomicU64::new(0);
static PENDING: Mutex<Option<(u64,mpsc::Sender<serde_json::Value>)>> = Mutex::new(None);
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct NativeStartup { state_load_ms: f64, pre_ui_ready_ms: f64 }
static NATIVE_STARTUP: OnceLock<NativeStartup> = OnceLock::new();
static SETUP_THREAD: OnceLock<ThreadId> = OnceLock::new();
pub(crate) fn set_native_startup(state_load_ms: f64, pre_ui_ready_ms: f64) {
    if enabled() { let _ = SETUP_THREAD.set(std::thread::current().id()); }
    let _ = NATIVE_STARTUP.set(NativeStartup { state_load_ms: state_load_ms.min(86_400_000.0), pre_ui_ready_ms: pre_ui_ready_ms.min(86_400_000.0) });
}

pub(crate) fn enabled() -> bool { std::env::args().any(|arg|arg=="--control-stdio") }

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct NativeHistoryCall {
    pub(crate) lock_wait_ms: f64,
    pub(crate) history_ms: f64,
    pub(crate) git_ms: f64,
    pub(crate) git_calls: u64,
    pub(crate) check_ms: f64,
    pub(crate) check_calls: u64,
    pub(crate) records: u64,
}
impl NativeHistoryCall {
    fn valid(&self) -> bool {
        [self.lock_wait_ms,self.history_ms,self.git_ms,self.check_ms].into_iter()
            .all(|ms|ms.is_finite()&&(0.0..=86_400_000.0).contains(&ms))
            && self.records<=1_000_000 && self.git_calls<=self.records && self.check_calls<=1_000_000
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all="camelCase")]
struct NativeHistory { calls: u64, latest: NativeHistoryCall }
static NATIVE_HISTORY: Mutex<NativeHistory> = Mutex::new(NativeHistory {
    calls: 0, latest: NativeHistoryCall { lock_wait_ms: 0.0, history_ms: 0.0, git_ms: 0.0, git_calls: 0, check_ms: 0.0, check_calls: 0, records: 0 },
});
pub(crate) fn record_native_history(call: NativeHistoryCall) {
    if enabled() && call.valid() {
        if let Ok(mut history)=NATIVE_HISTORY.lock() {
            history.calls=history.calls.saturating_add(1);
            history.latest=call;
        }
    }
}

const LAYOUT_MAX_MS: f64 = 86_400_000.0;
const LAYOUT_MAX_COUNT: u64 = 1_000_000;
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all="camelCase")]
struct NativeLayoutCall {
    layout_ms: f64, main_busy_ms: f64, position_ms: f64, size_ms: f64,
    position_calls: u64, size_calls: u64, wrapper_errors: u64, main_thread: u64,
}
impl NativeLayoutCall {
    fn valid(&self) -> bool {
        [self.layout_ms,self.main_busy_ms,self.position_ms,self.size_ms].into_iter()
            .all(|ms|ms.is_finite()&&(0.0..=LAYOUT_MAX_MS).contains(&ms))
            && self.main_busy_ms<=self.layout_ms && (self.main_thread==1 || self.main_busy_ms==0.0)
            && self.main_thread<=1 && self.position_calls<=64 && self.size_calls<=64
            && self.wrapper_errors<=self.position_calls+self.size_calls
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all="camelCase")]
struct NativeLayout {
    calls: u64, main_calls: u64, off_main_calls: u64, total_ms: f64, main_busy_ms: f64,
    main_position_ms: f64, main_size_ms: f64, position_calls: u64, size_calls: u64,
    wrapper_errors: u64, latest: NativeLayoutCall,
}
impl NativeLayout {
    fn record(&mut self, call: NativeLayoutCall) {
        if !call.valid() { return; }
        let count = |old: u64, new| old.saturating_add(new).min(LAYOUT_MAX_COUNT);
        let time = |old: f64, new: f64| (old+new).min(LAYOUT_MAX_MS);
        self.calls=count(self.calls,1);
        self.main_calls=count(self.main_calls,call.main_thread);
        self.off_main_calls=count(self.off_main_calls,1-call.main_thread);
        self.total_ms=time(self.total_ms,call.layout_ms);
        self.main_busy_ms=time(self.main_busy_ms,call.main_busy_ms);
        if call.main_thread==1 {
            self.main_position_ms=time(self.main_position_ms,call.position_ms);
            self.main_size_ms=time(self.main_size_ms,call.size_ms);
        }
        self.position_calls=count(self.position_calls,call.position_calls);
        self.size_calls=count(self.size_calls,call.size_calls);
        self.wrapper_errors=count(self.wrapper_errors,call.wrapper_errors);
        self.latest=call;
    }
}
static NATIVE_LAYOUT: Mutex<NativeLayout> = Mutex::new(NativeLayout {
    calls: 0, main_calls: 0, off_main_calls: 0, total_ms: 0.0, main_busy_ms: 0.0,
    main_position_ms: 0.0, main_size_ms: 0.0, position_calls: 0, size_calls: 0,
    wrapper_errors: 0, latest: NativeLayoutCall { layout_ms: 0.0, main_busy_ms: 0.0, position_ms: 0.0, size_ms: 0.0, position_calls: 0, size_calls: 0, wrapper_errors: 0, main_thread: 0 },
});
fn record_layout_into(target: &Mutex<NativeLayout>, call: NativeLayoutCall) {
    if let Ok(mut layout)=target.lock() { layout.record(call); }
}
thread_local! { static LAYOUT_DEPTH: Cell<usize> = const { Cell::new(0) }; }
pub(crate) struct NativeLayoutProbe { started: Instant, outermost: bool, call: NativeLayoutCall }
impl NativeLayoutProbe {
    fn begin(active: bool, setup_thread: Option<ThreadId>) -> Option<Self> {
        if !active { return None; }
        let outermost=LAYOUT_DEPTH.with(|depth| {
            let before=depth.get(); depth.set(before.checked_add(1)?); Some(before==0)
        })?;
        Some(Self { started: Instant::now(), outermost, call: NativeLayoutCall {
            main_thread: u64::from(setup_thread==Some(std::thread::current().id())), ..Default::default()
        } })
    }
    pub(crate) fn position<T,E>(&mut self, operation: impl FnOnce()->Result<T,E>) -> Result<T,E> {
        let started=Instant::now(); let result=operation();
        self.call.position_ms+=started.elapsed().as_secs_f64()*1000.0;
        self.call.position_calls=self.call.position_calls.saturating_add(1);
        self.call.wrapper_errors=self.call.wrapper_errors.saturating_add(u64::from(result.is_err()));
        result
    }
    pub(crate) fn size<T,E>(&mut self, operation: impl FnOnce()->Result<T,E>) -> Result<T,E> {
        let started=Instant::now(); let result=operation();
        self.call.size_ms+=started.elapsed().as_secs_f64()*1000.0;
        self.call.size_calls=self.call.size_calls.saturating_add(1);
        self.call.wrapper_errors=self.call.wrapper_errors.saturating_add(u64::from(result.is_err()));
        result
    }
    fn completed(&self) -> NativeLayoutCall {
        let layout_ms=self.started.elapsed().as_secs_f64()*1000.0;
        NativeLayoutCall { layout_ms, main_busy_ms: if self.outermost && self.call.main_thread==1 { layout_ms } else { 0.0 }, ..self.call }
    }
    pub(crate) fn finish(self) {
        record_layout_into(&NATIVE_LAYOUT,self.completed());
    }
}
impl Drop for NativeLayoutProbe {
    fn drop(&mut self) { LAYOUT_DEPTH.with(|depth|depth.set(depth.get().saturating_sub(1))); }
}
pub(crate) fn begin_native_layout() -> Option<NativeLayoutProbe> {
    NativeLayoutProbe::begin(enabled(),SETUP_THREAD.get().copied())
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    fn call() -> NativeLayoutCall {
        NativeLayoutCall { layout_ms: 10.0, main_busy_ms: 10.0, position_ms: 3.0, size_ms: 2.0, position_calls: 2, size_calls: 2, wrapper_errors: 1, main_thread: 1 }
    }
    #[test]
    fn layout_fixed_numeric_projection_and_boundaries() {
        let mut metrics=NativeLayout::default(); metrics.record(call());
        let value=serde_json::to_value(&metrics).unwrap();
        assert_eq!(value.as_object().unwrap().len(),11);
        assert_eq!(value["latest"].as_object().unwrap().len(),8);
        assert!(value.as_object().unwrap().iter().all(|(key,value)|key=="latest" || value.is_number()));
        assert!(value["latest"].as_object().unwrap().values().all(serde_json::Value::is_number));
        for ms in [-1.0,f64::NAN,f64::INFINITY,LAYOUT_MAX_MS+0.1] {
            for bad in [NativeLayoutCall{layout_ms:ms,..call()},NativeLayoutCall{main_busy_ms:ms,..call()},NativeLayoutCall{position_ms:ms,..call()},NativeLayoutCall{size_ms:ms,..call()}] { assert!(!bad.valid()); }
        }
        assert!(NativeLayoutCall{layout_ms:LAYOUT_MAX_MS,main_busy_ms:LAYOUT_MAX_MS,position_calls:64,size_calls:64,wrapper_errors:128,..call()}.valid());
        for bad in [NativeLayoutCall{main_thread:2,..call()},NativeLayoutCall{position_calls:65,..call()},NativeLayoutCall{size_calls:65,..call()},NativeLayoutCall{wrapper_errors:5,..call()},NativeLayoutCall{main_busy_ms:10.1,..call()},NativeLayoutCall{main_thread:0,..call()}] {assert!(!bad.valid());}
    }
    #[test]
    fn layout_saturates_cumulative_values_and_invalid_observations_are_ignored() {
        let mut metrics=NativeLayout { calls:u64::MAX, main_calls:u64::MAX, off_main_calls:u64::MAX,
            total_ms:LAYOUT_MAX_MS, main_busy_ms:LAYOUT_MAX_MS, main_position_ms:LAYOUT_MAX_MS,
            main_size_ms:LAYOUT_MAX_MS, position_calls:u64::MAX,size_calls:u64::MAX,wrapper_errors:u64::MAX,..Default::default() };
        metrics.record(call());
        assert_eq!(metrics.calls,LAYOUT_MAX_COUNT);assert_eq!(metrics.main_calls,LAYOUT_MAX_COUNT);
        assert_eq!(metrics.off_main_calls,LAYOUT_MAX_COUNT);assert_eq!(metrics.position_calls,LAYOUT_MAX_COUNT);
        assert_eq!(metrics.size_calls,LAYOUT_MAX_COUNT);assert_eq!(metrics.wrapper_errors,LAYOUT_MAX_COUNT);
        assert_eq!(metrics.total_ms,LAYOUT_MAX_MS);assert_eq!(metrics.main_busy_ms,LAYOUT_MAX_MS);
        assert_eq!(metrics.main_position_ms,LAYOUT_MAX_MS);assert_eq!(metrics.main_size_ms,LAYOUT_MAX_MS);
        let before=serde_json::to_value(&metrics).unwrap();
        metrics.record(NativeLayoutCall{position_ms:f64::NAN,..call()});
        assert_eq!(serde_json::to_value(&metrics).unwrap(),before);
    }
    #[test]
    fn layout_disabled_unknown_thread_and_depth_width_do_not_create_false_main_work() {
        assert!(NativeLayoutProbe::begin(false,Some(std::thread::current().id())).is_none());
        assert_eq!(LAYOUT_DEPTH.with(Cell::get),0);
        let unknown=NativeLayoutProbe::begin(true,None).unwrap();
        assert_eq!(unknown.completed().main_thread,0);assert_eq!(unknown.completed().main_busy_ms,0.0);drop(unknown);
        LAYOUT_DEPTH.with(|depth|depth.set(usize::MAX));
        assert!(NativeLayoutProbe::begin(true,None).is_none());
        assert_eq!(LAYOUT_DEPTH.with(Cell::get),usize::MAX);LAYOUT_DEPTH.with(|depth|depth.set(0));
    }
    #[test]
    fn layout_nested_main_calls_deduplicate_busy_and_other_thread_is_separate() {
        let main=std::thread::current().id(); let outer=NativeLayoutProbe::begin(true,Some(main)).unwrap();
        let inner=NativeLayoutProbe::begin(true,Some(main)).unwrap();let inner_call=inner.completed();
        assert_eq!(inner_call.main_thread,1);assert_eq!(inner_call.main_busy_ms,0.0);drop(inner);
        let outer_call=outer.completed();assert_eq!(outer_call.main_busy_ms,outer_call.layout_ms);
        let mut metrics=NativeLayout::default();metrics.record(inner_call);metrics.record(outer_call);drop(outer);
        assert_eq!(metrics.calls,2);assert_eq!(metrics.main_calls,2);assert_eq!(metrics.main_busy_ms,outer_call.layout_ms);
        let off=std::thread::spawn(move ||NativeLayoutProbe::begin(true,Some(main)).unwrap().completed()).join().unwrap();
        assert_eq!(off.main_thread,0);assert_eq!(off.main_busy_ms,0.0);
        let prior_position=metrics.main_position_ms;metrics.record(off);
        assert_eq!(metrics.off_main_calls,1);assert_eq!(metrics.main_position_ms,prior_position);
        assert_eq!(LAYOUT_DEPTH.with(Cell::get),0);
    }
    #[test]
    fn layout_wrapper_results_remain_exact_and_unwind_restores_depth() {
        let mut probe=NativeLayoutProbe::begin(true,Some(std::thread::current().id())).unwrap();
        assert_eq!(probe.position(||Ok::<_,&str>([1,2])),Ok([1,2]));
        assert_eq!(probe.size(||Err::<(),_>("native_error")),Err("native_error"));
        let observation=probe.completed();assert_eq!((observation.position_calls,observation.size_calls,observation.wrapper_errors),(1,1,1));assert!(observation.valid());drop(probe);
        let result=std::panic::catch_unwind(|| { let _probe=NativeLayoutProbe::begin(true,None).unwrap();panic!("fixture_unwind"); });
        assert!(result.is_err());assert_eq!(LAYOUT_DEPTH.with(Cell::get),0);
    }
    #[test]
    fn layout_poisoned_observation_does_not_change_the_operation_result() {
        let target=std::sync::Arc::new(Mutex::new(NativeLayout::default()));let other=target.clone();
        assert!(std::thread::spawn(move || {let _guard=other.lock().unwrap();panic!("fixture_poison");}).join().is_err());
        record_layout_into(&target,call());
        assert!(target.is_poisoned());
        let application_result:Result<(),&str>=Err("native_error");
        assert_eq!(application_result,Err("native_error"));
    }
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all="camelCase")]
struct NativeActivationCall {
    activation_ms: f64, main_busy_ms: f64, memory_ms: f64, show_ms: f64, hide_ms: f64, focus_ms: f64,
    memory_calls: u64, show_calls: u64, hide_calls: u64, focus_calls: u64, dispatch_errors: u64, main_thread: u64,
}
impl NativeActivationCall {
    fn valid(&self) -> bool {
        [self.activation_ms,self.main_busy_ms,self.memory_ms,self.show_ms,self.hide_ms,self.focus_ms].into_iter()
            .all(|ms|ms.is_finite()&&(0.0..=LAYOUT_MAX_MS).contains(&ms))
            && self.main_busy_ms<=self.activation_ms && (self.main_thread==1 || self.main_busy_ms==0.0)
            && self.main_thread<=1 && self.memory_calls<=64 && self.show_calls<=1 && self.hide_calls<=64 && self.focus_calls<=1
            && self.show_calls+self.hide_calls<=64 && self.dispatch_errors<=self.show_calls+self.hide_calls+self.focus_calls
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all="camelCase")]
struct NativeActivation {
    calls: u64, main_calls: u64, off_main_calls: u64, total_ms: f64, main_busy_ms: f64,
    main_memory_ms: f64, main_show_ms: f64, main_hide_ms: f64, main_focus_ms: f64,
    memory_calls: u64, show_calls: u64, hide_calls: u64, focus_calls: u64, dispatch_errors: u64, latest: NativeActivationCall,
}
impl NativeActivation {
    fn record(&mut self, call: NativeActivationCall) {
        if !call.valid() { return; }
        let count = |old: u64, new| old.saturating_add(new).min(LAYOUT_MAX_COUNT);
        let time = |old: f64, new: f64| (old+new).min(LAYOUT_MAX_MS);
        self.calls=count(self.calls,1); self.main_calls=count(self.main_calls,call.main_thread);
        self.off_main_calls=count(self.off_main_calls,1-call.main_thread);
        self.total_ms=time(self.total_ms,call.activation_ms); self.main_busy_ms=time(self.main_busy_ms,call.main_busy_ms);
        if call.main_thread==1 {
            self.main_memory_ms=time(self.main_memory_ms,call.memory_ms); self.main_show_ms=time(self.main_show_ms,call.show_ms);
            self.main_hide_ms=time(self.main_hide_ms,call.hide_ms); self.main_focus_ms=time(self.main_focus_ms,call.focus_ms);
        }
        self.memory_calls=count(self.memory_calls,call.memory_calls); self.show_calls=count(self.show_calls,call.show_calls);
        self.hide_calls=count(self.hide_calls,call.hide_calls); self.focus_calls=count(self.focus_calls,call.focus_calls);
        self.dispatch_errors=count(self.dispatch_errors,call.dispatch_errors); self.latest=call;
    }
}
static NATIVE_ACTIVATION: Mutex<NativeActivation> = Mutex::new(NativeActivation {
    calls:0,main_calls:0,off_main_calls:0,total_ms:0.0,main_busy_ms:0.0,
    main_memory_ms:0.0,main_show_ms:0.0,main_hide_ms:0.0,main_focus_ms:0.0,
    memory_calls:0,show_calls:0,hide_calls:0,focus_calls:0,dispatch_errors:0,
    latest:NativeActivationCall{activation_ms:0.0,main_busy_ms:0.0,memory_ms:0.0,show_ms:0.0,hide_ms:0.0,focus_ms:0.0,
        memory_calls:0,show_calls:0,hide_calls:0,focus_calls:0,dispatch_errors:0,main_thread:0},
});
fn record_activation_into(target: &Mutex<NativeActivation>, call: NativeActivationCall) {
    if let Ok(mut activation)=target.lock() { activation.record(call); }
}
thread_local! { static ACTIVATION_DEPTH: Cell<usize> = const { Cell::new(0) }; }
enum ActivationOperation { Show, Hide, Focus }
pub(crate) struct NativeActivationProbe { started: Instant, outermost: bool, call: NativeActivationCall }
impl NativeActivationProbe {
    fn begin(active: bool, setup_thread: Option<ThreadId>) -> Option<Self> {
        if !active { return None; }
        let outermost=ACTIVATION_DEPTH.with(|depth| {
            let before=depth.get(); depth.set(before.checked_add(1)?); Some(before==0)
        })?;
        Some(Self { started:Instant::now(),outermost,call:NativeActivationCall {
            main_thread:u64::from(setup_thread==Some(std::thread::current().id())),..Default::default()
        } })
    }
    pub(crate) fn memory<T>(&mut self, operation: impl FnOnce()->T) -> T {
        let started=Instant::now();let result=operation();
        self.call.memory_ms+=started.elapsed().as_secs_f64()*1000.0;
        self.call.memory_calls=self.call.memory_calls.saturating_add(1);result
    }
    fn result<T,E>(&mut self, kind: ActivationOperation, operation: impl FnOnce()->Result<T,E>) -> Result<T,E> {
        let started=Instant::now();let result=operation();
        let (ms,calls)=match kind {
            ActivationOperation::Show=>(&mut self.call.show_ms,&mut self.call.show_calls),
            ActivationOperation::Hide=>(&mut self.call.hide_ms,&mut self.call.hide_calls),
            ActivationOperation::Focus=>(&mut self.call.focus_ms,&mut self.call.focus_calls),
        };
        *ms+=started.elapsed().as_secs_f64()*1000.0;*calls=calls.saturating_add(1);
        self.call.dispatch_errors=self.call.dispatch_errors.saturating_add(u64::from(result.is_err()));result
    }
    pub(crate) fn show<T,E>(&mut self, operation: impl FnOnce()->Result<T,E>) -> Result<T,E> { self.result(ActivationOperation::Show,operation) }
    pub(crate) fn hide<T,E>(&mut self, operation: impl FnOnce()->Result<T,E>) -> Result<T,E> { self.result(ActivationOperation::Hide,operation) }
    pub(crate) fn focus<T,E>(&mut self, operation: impl FnOnce()->Result<T,E>) -> Result<T,E> { self.result(ActivationOperation::Focus,operation) }
    fn completed(&self) -> NativeActivationCall {
        let activation_ms=self.started.elapsed().as_secs_f64()*1000.0;
        NativeActivationCall { activation_ms,main_busy_ms:if self.outermost && self.call.main_thread==1 { activation_ms } else { 0.0 },..self.call }
    }
    pub(crate) fn finish(self) { record_activation_into(&NATIVE_ACTIVATION,self.completed()); }
}
impl Drop for NativeActivationProbe {
    fn drop(&mut self) { ACTIVATION_DEPTH.with(|depth|depth.set(depth.get().saturating_sub(1))); }
}
pub(crate) fn begin_native_activation() -> Option<NativeActivationProbe> {
    NativeActivationProbe::begin(enabled(),SETUP_THREAD.get().copied())
}

#[cfg(test)]
mod activation_tests {
    use super::*;
    fn call() -> NativeActivationCall { NativeActivationCall {activation_ms:10.0,main_busy_ms:10.0,memory_ms:2.0,show_ms:1.0,hide_ms:3.0,focus_ms:1.0,
        memory_calls:64,show_calls:1,hide_calls:63,focus_calls:1,dispatch_errors:65,main_thread:1} }
    #[test]
    fn activation_schema_numerical_and_width_boundaries() {
        let mut metrics=NativeActivation::default();metrics.record(call());let value=serde_json::to_value(&metrics).unwrap();
        assert_eq!(value.as_object().unwrap().len(),15);assert_eq!(value["latest"].as_object().unwrap().len(),12);
        assert!(value.as_object().unwrap().iter().all(|(k,v)|k=="latest" || v.is_number()));assert!(value["latest"].as_object().unwrap().values().all(serde_json::Value::is_number));
        for ms in [-1.0,f64::NAN,f64::INFINITY,LAYOUT_MAX_MS+0.1] {
            for bad in [NativeActivationCall{activation_ms:ms,..call()},NativeActivationCall{main_busy_ms:ms,..call()},NativeActivationCall{memory_ms:ms,..call()},NativeActivationCall{show_ms:ms,..call()},NativeActivationCall{hide_ms:ms,..call()},NativeActivationCall{focus_ms:ms,..call()}] {assert!(!bad.valid());}
        }
        assert!(NativeActivationCall{activation_ms:LAYOUT_MAX_MS,main_busy_ms:LAYOUT_MAX_MS,..call()}.valid());
        for bad in [NativeActivationCall{main_thread:2,..call()},NativeActivationCall{memory_calls:65,..call()},NativeActivationCall{show_calls:2,..call()},NativeActivationCall{hide_calls:64,..call()},NativeActivationCall{focus_calls:2,..call()},NativeActivationCall{dispatch_errors:66,..call()},NativeActivationCall{main_busy_ms:10.1,..call()},NativeActivationCall{main_thread:0,..call()}] {assert!(!bad.valid());}
        metrics.calls=u64::MAX;metrics.main_calls=u64::MAX;metrics.memory_calls=u64::MAX;metrics.total_ms=LAYOUT_MAX_MS;
        metrics.record(call());assert_eq!(metrics.calls,LAYOUT_MAX_COUNT);assert_eq!(metrics.main_calls,LAYOUT_MAX_COUNT);assert_eq!(metrics.memory_calls,LAYOUT_MAX_COUNT);assert_eq!(metrics.total_ms,LAYOUT_MAX_MS);
        let before=serde_json::to_value(&metrics).unwrap();metrics.record(NativeActivationCall{memory_ms:f64::NAN,..call()});assert_eq!(serde_json::to_value(&metrics).unwrap(),before);
    }
    #[test]
    fn activation_disabled_nested_thread_and_depth_boundaries() {
        let owner=std::thread::current().id();assert!(NativeActivationProbe::begin(false,Some(owner)).is_none());assert_eq!(ACTIVATION_DEPTH.with(Cell::get),0);
        let outer=NativeActivationProbe::begin(true,Some(owner)).unwrap();let inner=NativeActivationProbe::begin(true,Some(owner)).unwrap();let mut metrics=NativeActivation::default();metrics.record(inner.completed());assert_eq!(metrics.main_busy_ms,0.0);drop(inner);
        let outer_call=outer.completed();metrics.record(outer_call);assert_eq!(metrics.main_busy_ms,outer_call.activation_ms);drop(outer);
        let off=std::thread::spawn(move ||NativeActivationProbe::begin(true,Some(owner)).unwrap().completed()).join().unwrap();assert_eq!(off.main_thread,0);assert_eq!(off.main_busy_ms,0.0);metrics.record(off);assert_eq!(metrics.off_main_calls,1);
        let unknown=NativeActivationProbe::begin(true,None).unwrap();assert_eq!(unknown.completed().main_thread,0);drop(unknown);
        ACTIVATION_DEPTH.with(|d|d.set(usize::MAX));assert!(NativeActivationProbe::begin(true,None).is_none());ACTIVATION_DEPTH.with(|d|d.set(0));
    }
    #[test]
    fn activation_wrappers_preserve_sequence_results_and_memory_has_no_error_claim() {
        let mut p=NativeActivationProbe::begin(true,Some(std::thread::current().id())).unwrap();let mut order=Vec::new();
        p.memory(||order.push("memory"));assert_eq!(p.show(|| {order.push("show");Ok::<_,&str>(7)}),Ok(7));
        assert_eq!(p.focus(|| {order.push("focus");Err::<(),_>("focus_failed")}),Err("focus_failed"));
        assert_eq!(p.hide(|| {order.push("hide");Err::<(),_>("hide_failed")}),Err("hide_failed"));p.memory(||order.push("memory"));
        assert_eq!(order,["memory","show","focus","hide","memory"]);let c=p.completed();assert_eq!((c.memory_calls,c.show_calls,c.hide_calls,c.focus_calls,c.dispatch_errors),(2,1,1,1,2));assert!(c.valid());drop(p);
        assert!(std::panic::catch_unwind(|| {let _p=NativeActivationProbe::begin(true,None).unwrap();panic!("fixture_unwind");}).is_err());assert_eq!(ACTIVATION_DEPTH.with(Cell::get),0);
    }
    #[test]
    fn activation_poisoned_observation_does_not_propagate() {
        let target=std::sync::Arc::new(Mutex::new(NativeActivation::default()));let other=target.clone();
        assert!(std::thread::spawn(move || {let _guard=other.lock().unwrap();panic!("fixture_poison");}).join().is_err());
        record_activation_into(&target,call());assert!(target.is_poisoned());
    }
}

pub(crate) fn observe(app: &AppHandle) -> Result<serde_json::Value,String> {
    let id=NEXT.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|id|id.checked_add(1))
        .map_err(|_|"metrics_exhausted")?+1;
    let (tx,rx)=mpsc::channel();
    *PENDING.lock().map_err(|_|"metrics_unavailable")?=Some((id,tx));
    let outcome: Result<serde_json::Value,String>=app.emit_to("main","desktop-control-metrics",serde_json::json!({"requestId":id})).map_err(|_|String::from("metrics_dispatch_failed"))
        .and_then(|_|rx.recv_timeout(Duration::from_secs(10)).map_err(|_|"metrics_timeout".into()));
    if let Ok(mut pending)=PENDING.lock() { if pending.as_ref().is_some_and(|(active,_)|*active==id){*pending=None;} }
    outcome.map(|mut value| {
        if let Some(startup) = NATIVE_STARTUP.get() {
            value["nativeStartup"] = serde_json::to_value(startup).expect("finite native durations");
        }
        if enabled() {
            if let Ok(history)=NATIVE_HISTORY.lock() {
                if let Ok(snapshot)=serde_json::to_value(&*history) { value["nativeHistory"]=snapshot; }
            }
            if let Ok(layout)=NATIVE_LAYOUT.lock() {
                if let Ok(snapshot)=serde_json::to_value(&*layout) { value["nativeLayout"]=snapshot; }
            }
            if let Ok(activation)=NATIVE_ACTIVATION.lock() {
                if let Ok(snapshot)=serde_json::to_value(&*activation) { value["nativeActivation"]=snapshot; }
            }
        }
        value
    })
}

#[tauri::command]
pub(crate) fn desktop_control_metrics_report(window: tauri::Webview, request_id: u64, snapshot: Snapshot) -> Result<(),String> {
    crate::native_pi(&window)?;
    if window.label()!="main" || !enabled() { return Err("metrics_disabled".into()); }
    if !snapshot.valid() { return Err("invalid_metrics".into()); }
    let pending=PENDING.lock().map_err(|_|"metrics_unavailable")?;
    let (_,tx)=pending.as_ref().filter(|(id,_)|*id==request_id).ok_or("metrics_request_expired")?;
    tx.send(serde_json::to_value(snapshot).map_err(|_|"invalid_metrics")?).map_err(|_|"metrics_request_expired".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    // BEGIN focused_optional_inflight
    #[test]
    fn optional_inflight_missing_and_null_remain_unknown_not_zero() {
        for field in ["",",\"inFlight\":null"] {
            let body=format!("{{\"elapsedMs\":10,\"phases\":[{{\"name\":\"browserFetch\",\"calls\":1,\"totalMs\":1,\"busyMs\":1{field}}}],\"marks\":[]}}");
            let snapshot:Snapshot=serde_json::from_str(&body).unwrap();assert!(snapshot.valid());assert_eq!(snapshot.phases[0].in_flight,None);
            assert!(serde_json::to_value(&snapshot).unwrap()["phases"][0].get("inFlight").is_none());
        }
        let phase:Phase=serde_json::from_str(r#"{"name":"browserFetch","calls":1,"totalMs":1,"busyMs":1,"inFlight":0}"#).unwrap();
        assert_eq!(phase.in_flight,Some(0));assert_eq!(serde_json::to_value(&phase).unwrap()["inFlight"],0);
    }
    #[test]
    fn optional_inflight_type_width_and_closed_schema_reject() {
        for value in ["-1","1.5","\"1\"","true","[]","{}","18446744073709551616"] {
            let body=format!("{{\"name\":\"browserFetch\",\"calls\":1,\"totalMs\":1,\"busyMs\":1,\"inFlight\":{value}}}");
            assert!(serde_json::from_str::<Phase>(&body).is_err());
        }
        assert!(serde_json::from_str::<Phase>(r#"{"name":"browserFetch","calls":1,"totalMs":1,"busyMs":1,"inFlight":0,"unknown":1}"#).is_err());
        let widest:Phase=serde_json::from_str(r#"{"name":"browserFetch","calls":1,"totalMs":1,"busyMs":1,"inFlight":18446744073709551615}"#).unwrap();
        assert_eq!(widest.in_flight,Some(u64::MAX));
    }
    #[test]
    fn optional_inflight_validity_bounds_against_calls_and_cap() {
        let mut snapshot:Snapshot=serde_json::from_str(r#"{"elapsedMs":10,"phases":[{"name":"browserRefresh","calls":2,"totalMs":1,"busyMs":1,"inFlight":2}],"marks":[]}"#).unwrap();
        assert!(snapshot.valid());snapshot.phases[0].in_flight=Some(3);assert!(!snapshot.valid());
        snapshot.phases[0].calls=1_000_000;snapshot.phases[0].in_flight=Some(1_000_000);assert!(snapshot.valid());
        snapshot.phases[0].in_flight=Some(1_000_001);assert!(!snapshot.valid());
        snapshot.phases[0].in_flight=Some(u64::MAX);assert!(!snapshot.valid());
    }
    // END focused_optional_inflight
    fn valid() -> Snapshot { serde_json::from_str(r#"{"elapsedMs":100,"phases":[{"name":"feed","calls":1,"totalMs":10,"busyMs":10}],"marks":[{"name":"moduleReady","atMs":20}]}"#).unwrap() }
    #[test]
    fn numeric_schema_rejects_unknown_names_fields_content_and_duplicates() {
        assert!(valid().valid());
        let raw=serde_json::to_string(&valid()).unwrap();
        for bad in [raw.replace("feed","prompt"),raw.replace("\"calls\":1","\"calls\":1,\"text\":\"secret\""),raw.replace("\"atMs\":20","\"atMs\":\"20\"")] { assert!(serde_json::from_str::<Snapshot>(&bad).is_err()); }
        let mut s=valid();s.phases.push(Phase{name:Name::Feed,calls:1,total_ms:1.0,busy_ms:1.0,in_flight:None});assert!(!s.valid());
        s=valid();s.phases[0].name=Name::ModuleReady;assert!(!s.valid());
        s=valid();s.marks[0].name=Name::BrowserFetch;assert!(!s.valid());
    }
    #[test]
    fn numerical_and_collection_boundaries_fail_closed() {
        for ms in [-1.0,f64::NAN,f64::INFINITY,86_400_000.1] {let mut s=valid();s.elapsed_ms=ms;assert!(!s.valid());s=valid();s.phases[0].total_ms=ms;assert!(!s.valid());s=valid();s.phases[0].busy_ms=ms;assert!(!s.valid());}
        let mut s=valid();s.phases[0].busy_ms=100.01;assert!(!s.valid());s.phases[0].busy_ms=100.0;assert!(s.valid());
        let mut s=valid();s.phases[0].calls=1_000_001;assert!(!s.valid());s.phases[0].calls=1_000_000;assert!(s.valid());
        s.marks[0].at_ms=100.01;assert!(!s.valid());s.marks[0].at_ms=100.0;assert!(s.valid());
        s.marks=(0..25).map(|_|Mark{name:Name::ModuleReady,at_ms:1.0}).collect();assert!(!s.valid());
    }
    #[test]
    fn history_ui_phases_are_closed_and_distinct() {
        let mut s=valid();
        for name in [Name::LastSessionRead,Name::HistoryRender,Name::WorkHistory] {
            s.phases.push(Phase{name,calls:1,total_ms:1.0,busy_ms:1.0,in_flight:None});
        }
        assert!(s.valid());
        assert!(serde_json::from_str::<Name>(r#""lastSessionReads""#).is_err());
        assert_eq!(serde_json::to_value(Name::WorkHistory).unwrap(),"workHistory");
        s.marks.push(Mark{name:Name::HistoryRender,at_ms:1.0});assert!(!s.valid());
    }
    #[test]
    fn complete_eighteen_phase_seven_mark_schema_fits_existing_bound() {
        let phases=[Name::Workspace,Name::Agents,Name::Attach,Name::LastSession,Name::Feed,Name::Node,Name::Games,Name::BrowserFetch,Name::BrowserRender,Name::BrowserRefresh,Name::FeedReadyWait,Name::FeedLocal,Name::FeedConnected,Name::FeedDistributed,Name::FeedFederated,Name::LastSessionRead,Name::HistoryRender,Name::WorkHistory];
        let marks=[Name::ModuleReady,Name::UiWired,Name::StartupComplete,Name::FeedReady,Name::FeedApplied,Name::FeedSuperseded,Name::FeedFailed];
        let snapshot=Snapshot{elapsed_ms:100.0,phases:phases.into_iter().map(|name|Phase{name,calls:1,total_ms:1.0,busy_ms:1.0,in_flight:None}).collect(),marks:marks.into_iter().map(|name|Mark{name,at_ms:1.0}).collect()};
        assert_eq!((snapshot.phases.len(),snapshot.marks.len()),(18,7));assert!(snapshot.valid());
    }
    #[test]
    fn native_history_is_fixed_numeric_and_bounded() {
        let call=NativeHistoryCall{records:2,git_calls:2,check_calls:3,lock_wait_ms:1.0,history_ms:5.0,git_ms:2.0,check_ms:1.0};
        assert!(call.valid());
        let value=serde_json::to_value(NativeHistory{calls:1,latest:call}).unwrap();
        assert_eq!(value.as_object().unwrap().len(),2);
        let latest=value["latest"].as_object().unwrap();
        assert_eq!(latest.len(),7);
        assert!(latest.values().all(serde_json::Value::is_number));
        for ms in [-1.0,f64::NAN,f64::INFINITY,86_400_000.1] {
            assert!(!NativeHistoryCall{history_ms:ms,..call}.valid());
        }
        assert!(NativeHistoryCall{history_ms:86_400_000.0,..call}.valid());
        assert!(!NativeHistoryCall{git_calls:3,..call}.valid());
        assert!(!NativeHistoryCall{records:1_000_001,..call}.valid());
        assert!(!NativeHistoryCall{check_calls:1_000_001,..call}.valid());
    }
}
