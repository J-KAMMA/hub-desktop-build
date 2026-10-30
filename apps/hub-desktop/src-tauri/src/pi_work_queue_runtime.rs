//! Main-window queue adapter. Reads never launch; only an explicit reservation or
//! the owner of a completed run may request a drain after releasing its lease.
use super::{queue as q, PiRunState, PiWorkService, WorkEngine};
use serde::Deserialize;
use std::{collections::HashSet, path::PathBuf, sync::Arc};

#[derive(Default)]
pub(super) struct Runtime {
    pub(super) store: q::QueueStore,
    bridge_id: Option<String>,
    anchor_run_id: Option<String>,
    released: HashSet<String>,
}

#[cfg(test)]
#[derive(Clone)]
pub(super) struct TestFixture { pub workspace: PathBuf, pub script: PathBuf }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRequest {
    bridge_id: String,
    anchor_run_id: String,
    expected_workspace: String,
    expected_model: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextToken { context: String }

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ActionRequest {
    Enqueue { context: String, expected_revision: u64, request_id: String, anchor_run_id: String, text: String },
    Edit { context: String, expected_revision: u64, request_id: String, queue_id: String, text: String },
    Cancel { context: String, expected_revision: u64, request_id: String, queue_id: String },
    Reorder { context: String, expected_revision: u64, request_id: String, queue_id: String,
        #[serde(deserialize_with = "explicit_optional")] before_queue_id: Option<String> },
    Resume { context: String, expected_revision: u64, request_id: String, queue_id: String, anchor_run_id: String },
}

fn explicit_optional<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

fn window_gate(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(window.label(), &url) { return Err("native_window_required".into()); }
    Ok(())
}

fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.get_version_num() == 4 && id.get_variant() == uuid::Variant::RFC4122 && id.to_string() == value)
}

fn selected_workspace(service: &PiWorkService) -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(fixture) = &service.queue_fixture { return Ok(fixture.workspace.clone()); }
    #[cfg(not(test))]
    let _ = service;
    crate::dev_cli::workspace().ok_or_else(|| "pi_queue_unavailable".into())
}

fn permissions(run: &PiRunState) -> q::Permissions {
    q::Permissions { allow_write: run.allow_write, allow_exec: run.allow_exec, allow_http: run.allow_http }
}

fn anchor(service: &PiWorkService, id: &str) -> Result<q::Anchor, String> {
    if !uuid(id) { return Err("pi_queue_invalid".into()); }
    let run = service.run(id).ok_or("pi_queue_unavailable")?;
    let state = PiWorkService::snapshot(&run);
    if selected_workspace(service)? != run.workspace || state.allow_write
        || !matches!(state.status.as_str(), "running" | "done" | "failed" | "cancelled") {
        return Err("pi_queue_unavailable".into());
    }
    if run.wait.lock().unwrap().is_none() {
        let checkpoint=service.resume_checkpoint(id,&run.workspace).map_err(|_| "pi_queue_unavailable")?;
        if !checkpoint.run.as_ref().is_some_and(|saved| saved.id==state.id && saved.model==state.model
            && saved.engine==state.engine && saved.allow_write==state.allow_write
            && saved.allow_exec==state.allow_exec && saved.allow_http==state.allow_http
            && super::non_verbatim(PathBuf::from(&saved.workspace))==super::non_verbatim(run.workspace.clone())) {
            return Err("pi_queue_unavailable".into());
        }
    }
    // A live wait handle must have completed. Restored records have no handle
    // and still need the authenticated checkpoint proof below.
    let known_released = service.queue.lock().unwrap().released.contains(id);
    let released = known_released || run.wait.lock().unwrap().as_ref().is_none_or(|wait| wait.is_finished());
    let ready = state.status != "running" && released && state.continuation.available
        && service.resume_checkpoint(id, &run.workspace).is_ok();
    Ok(q::Anchor { run_id: id.into(), requested_run_id:None, workspace: super::non_verbatim(run.workspace.clone()).to_string_lossy().into_owned(),
        model: state.model.clone(), engine: state.engine, permissions: permissions(&state), ready })
}

fn validate_context(service: &PiWorkService, token: &str) -> Result<q::Context, String> {
    if !uuid(token) { return Err("pi_queue_invalid".into()); }
    let mut runtime = service.queue.lock().unwrap();
    let snapshot = runtime.store.snapshot();
    let context = snapshot.context.filter(|context| context.token == token).ok_or("pi_queue_stale")?;
    let current = selected_workspace(service).ok().map(super::non_verbatim)
        .is_some_and(|path| path.to_string_lossy() == context.workspace);
    if !current {
        runtime.store.set_context(None, false)?;
        runtime.bridge_id = None;
        runtime.anchor_run_id = None;
        return Err("pi_queue_stale".into());
    }
    Ok(context)
}

#[tauri::command]
pub async fn pi_work_queue_context(window: tauri::Webview, request: ContextRequest,
    service: tauri::State<'_, PiWorkService>) -> Result<serde_json::Value, String> {
    window_gate(&window)?;
    if !uuid(&request.bridge_id) { return Err("pi_queue_invalid".into()); }
    let proof = anchor(&service, &request.anchor_run_id)?;
    let mut runtime = service.queue.lock().unwrap();
    if proof.workspace != request.expected_workspace || proof.model != request.expected_model {
        runtime.store.set_context(None, false)?;
        runtime.bridge_id = None;
        runtime.anchor_run_id = None;
        return Err("pi_queue_stale".into());
    }
    let old = runtime.store.snapshot();
    let same = runtime.bridge_id.as_ref() == Some(&request.bridge_id)
        && old.context.as_ref().is_some_and(|context| context.workspace == proof.workspace
            && context.model == proof.model && context.engine == proof.engine && context.permissions == proof.permissions);
    let token = if same { old.context.unwrap().token } else { uuid::Uuid::new_v4().to_string() };
    let context = q::Context { token, workspace: proof.workspace, model: proof.model,
        engine: proof.engine, permissions: proof.permissions };
    runtime.bridge_id = Some(request.bridge_id);
    runtime.anchor_run_id = Some(request.anchor_run_id);
    Ok(serde_json::json!(runtime.store.set_context(Some(context), true)?))
}

#[tauri::command]
pub async fn pi_work_queue_snapshot(window: tauri::Webview, request: ContextToken,
    service: tauri::State<'_, PiWorkService>) -> Result<serde_json::Value, String> {
    window_gate(&window)?;
    validate_context(&service, &request.context)?;
    Ok(serde_json::json!(service.queue.lock().unwrap().store.snapshot()))
}

#[tauri::command]
pub async fn pi_work_queue_release(window: tauri::Webview, request: ContextToken,
    service: tauri::State<'_, PiWorkService>) -> Result<serde_json::Value, String> {
    window_gate(&window)?;
    if !uuid(&request.context) { return Err("pi_queue_invalid".into()); }
    let mut runtime = service.queue.lock().unwrap();
    // A delayed release for a superseded bridge must not affect its replacement.
    if runtime.store.snapshot().context.as_ref().is_some_and(|context| context.token == request.context) {
        runtime.store.set_context(None, false)?;
        runtime.bridge_id = None;
        runtime.anchor_run_id = None;
    }
    Ok(serde_json::json!({"released":true}))
}

#[tauri::command]
pub async fn pi_work_queue_action(window: tauri::Webview, request: ActionRequest,
    service: tauri::State<'_, PiWorkService>, state: tauri::State<'_, Arc<crate::RunnerState>>) -> Result<serde_json::Value, String> {
    window_gate(&window)?;
    apply_action(&service, &state.dev_runs, request)
}

fn apply_action(service: &PiWorkService, leases: &Arc<tokio::sync::Mutex<crate::dev_cli::DevRuns>>,
    request: ActionRequest) -> Result<serde_json::Value, String> {
    let (context, expected_revision, request_id, kind, anchor_id) = match request {
        ActionRequest::Enqueue { context, expected_revision, request_id, anchor_run_id, text } =>
            (context, expected_revision, request_id, q::OperationKind::Enqueue { text }, Some(anchor_run_id)),
        ActionRequest::Edit { context, expected_revision, request_id, queue_id, text } =>
            (context, expected_revision, request_id, q::OperationKind::Edit { queue_id, text }, None),
        ActionRequest::Cancel { context, expected_revision, request_id, queue_id } =>
            (context, expected_revision, request_id, q::OperationKind::Cancel { queue_id }, None),
        ActionRequest::Reorder { context, expected_revision, request_id, queue_id, before_queue_id } =>
            (context, expected_revision, request_id, q::OperationKind::Reorder { queue_id, before_queue_id }, None),
        ActionRequest::Resume { context, expected_revision, request_id, queue_id, anchor_run_id } =>
            (context, expected_revision, request_id, q::OperationKind::Resume { queue_id }, Some(anchor_run_id)),
    };
    validate_context(&service, &context)?;
    let proof = anchor_id.as_deref().map(|id| {
        let execution_id = service.queue.lock().unwrap().store.execution_anchor(id)?;
        let mut proof = anchor(&service, &execution_id)?;
        proof.requested_run_id = Some(id.into());
        Ok::<_,String>(proof)
    }).transpose()?;
    if proof.as_ref().is_some_and(|proof| !proof.ready
        && service.status(&proof.run_id).is_none_or(|run| run.status != "running")) {
        return Err("pi_queue_unavailable".into());
    }
    let receipt = service.queue.lock().unwrap().store.apply(q::Operation { context, request_id, expected_revision, kind },
        proof.as_ref(), super::now_ms().try_into().map_err(|_| "pi_queue_unavailable")?)?;
    if proof.as_ref().is_some_and(|proof| proof.ready) {
        schedule(service.clone(), leases.clone());
    }
    Ok(serde_json::json!(receipt))
}

pub(super) fn registered(service: &PiWorkService, claim: &q::Claim, run_id: &str) -> Result<(), String> {
    service.queue.lock().unwrap().store.registered(claim, run_id).map(|_| ())
}

pub(super) fn validate_claim(service: &PiWorkService, claim: &q::Claim) -> Result<(), String> {
    let snapshot = service.queue.lock().unwrap().store.snapshot();
    let context = snapshot.context.filter(|context| context.token == claim.context).ok_or("pi_queue_stale")?;
    validate_selected(service, &context)?;
    if !snapshot.available || !snapshot.items.iter().any(|item| item.queue_id == claim.item.queue_id
        && item.state == q::QueueState::Starting && item.native_run_id.is_none()) {
        return Err("pi_queue_stale".into());
    }
    Ok(())
}

pub(super) struct StartGuard { service: PiWorkService, claim: Option<q::Claim>, may_have_started: bool }
impl StartGuard {
    pub fn new(service: &PiWorkService, claim: Option<q::Claim>) -> Self { Self { service: service.clone(), claim, may_have_started:false } }
    pub fn spawning(&mut self) { self.may_have_started = true; }
    pub fn validate(&self) -> Result<(), String> {
        self.claim.as_ref().map(|claim| validate_claim(&self.service, claim)).transpose().map(|_| ())
    }
    pub fn registered(&mut self, run_id: &str) -> Result<(), String> {
        if let Some(claim) = &self.claim { registered(&self.service, claim, run_id)?; }
        self.claim = None;
        Ok(())
    }
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        if let Some(claim) = &self.claim {
            let mut runtime=self.service.queue.lock().unwrap();
            let _ = if self.may_have_started { runtime.store.unknown(claim) } else { runtime.store.not_started(claim) };
        }
    }
}

pub(crate) fn after_terminal(service: PiWorkService, leases: Arc<tokio::sync::Mutex<crate::dev_cli::DevRuns>>, run: &PiRunState) {
    let affected = service.queue.lock().unwrap().store.snapshot().items.iter().any(|item|
        item.anchor_run_id == run.id || item.native_run_id.as_deref() == Some(run.id.as_str()));
    if !affected { return; }
    let continuation = run.status == "done" && run.continuation.available
        && service.run(&run.id).is_some_and(|actual| service.resume_checkpoint(&run.id, &actual.workspace).is_ok());
    let phase = match run.status.as_str() { "done" => q::QueueState::Done, "cancelled" => q::QueueState::Cancelled, _ => q::QueueState::Failed };
    let mut runtime = service.queue.lock().unwrap();
    let snapshot = runtime.store.snapshot();
    let referenced: HashSet<_> = snapshot.items.iter().map(|item| item.anchor_run_id.clone())
        .chain(runtime.anchor_run_id.iter().cloned()).collect();
    runtime.released.retain(|id| referenced.contains(id));
    runtime.released.insert(run.id.clone());
    let _ = runtime.store.finish(&run.id, phase, continuation);
    if !continuation {
        let context = runtime.store.snapshot().context;
        let _ = runtime.store.set_context(context, false);
    }
    drop(runtime);
    if continuation { schedule(service, leases); }
}

fn schedule(service: PiWorkService, leases: Arc<tokio::sync::Mutex<crate::dev_cli::DevRuns>>) {
    let future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(async move {
        let Some(next) = service.queue.lock().unwrap().store.next_ready() else { return; };
        let Ok(proof) = anchor(&service, &next.anchor_run_id) else { return; };
        if !proof.ready { return; }
        let claim = {
            let mut runtime = service.queue.lock().unwrap();
            let snapshot = runtime.store.snapshot();
            let Some(context) = snapshot.context else { return; };
            if validate_selected(&service, &context).is_err() { let _ = runtime.store.set_context(None, false); return; }
            match runtime.store.begin_start(&context.token, snapshot.revision, &proof) { Ok(claim) => claim, Err(_) => return }
        };
        let item = &claim.item;
        let mut guard = StartGuard::new(&service, Some(claim.clone()));
        let Ok(workspace) = super::resolve_workspace(&item.workspace) else { return; };
        #[cfg(test)]
        let script = service.queue_fixture.as_ref().and_then(|fixture| fixture.script.to_str());
        #[cfg(not(test))]
        let script = None;
        let result = super::launch_inner(&service, &leases, workspace, &item.text,
            Some(&item.model), script, item.permissions.allow_write, item.permissions.allow_exec,
            item.permissions.allow_http, Some(&item.anchor_run_id), item.engine, None, None, Some(claim.clone()), Vec::new()).await;
        if let Ok(run) = result { let _ = guard.registered(&run.id); }
    });
    tokio::spawn(future);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String { uuid::Uuid::new_v4().to_string() }
    fn claim_fixture() -> (PiWorkService, q::Claim) {
        let service = PiWorkService::default();
        let context = q::Context { token:id(), workspace:"C:/queue-fixture".into(), model:"ollama/model".into(),
            engine:WorkEngine::Thin, permissions:q::Permissions { allow_write:false,allow_exec:true,allow_http:true } };
        let proof = q::Anchor { run_id:id(),requested_run_id:None,workspace:context.workspace.clone(),model:context.model.clone(),
            engine:context.engine,permissions:context.permissions.clone(),ready:true };
        let claim = {
            let mut runtime = service.queue.lock().unwrap();
            let snapshot = runtime.store.set_context(Some(context.clone()),true).unwrap();
            runtime.store.apply(q::Operation { context:context.token.clone(),request_id:id(),expected_revision:snapshot.revision,
                kind:q::OperationKind::Enqueue {text:"next task".into()} },Some(&proof),1).unwrap();
            let revision=runtime.store.snapshot().revision;
            runtime.store.begin_start(&context.token,revision,&proof).unwrap()
        };
        (service,claim)
    }
    #[test]
    fn dropped_launch_remains_unknown_without_replay() {
        let (service,claim)=claim_fixture();
        let mut guard=StartGuard::new(&service,Some(claim));guard.spawning();drop(guard);
        let runtime=service.queue.lock().unwrap();
        assert_eq!(runtime.store.snapshot().items[0].state,q::QueueState::Unknown);
        assert!(runtime.store.next_ready().is_none());
    }
    #[test]
    fn dropped_prelaunch_claim_is_held_and_can_be_cancelled() {
        let (service,claim)=claim_fixture();let queue_id=claim.item.queue_id.clone();
        drop(StartGuard::new(&service,Some(claim)));
        let mut runtime=service.queue.lock().unwrap();let snapshot=runtime.store.snapshot();
        assert_eq!(snapshot.items[0].state,q::QueueState::Held);
        let context=snapshot.context.unwrap().token;
        assert!(runtime.store.apply(q::Operation{context,expected_revision:snapshot.revision,request_id:id(),
            kind:q::OperationKind::Cancel{queue_id}},None,2).is_ok());
    }
    #[test]
    fn actual_registered_run_survives_guard_drop_and_context_release() {
        let (service,claim)=claim_fixture();
        let mut guard=StartGuard::new(&service,Some(claim));
        service.queue.lock().unwrap().store.set_context(None,false).unwrap();
        let actual=id();guard.registered(&actual).unwrap();drop(guard);
        let snapshot=service.queue.lock().unwrap().store.snapshot();
        assert_eq!(snapshot.items[0].native_run_id.as_deref(),Some(actual.as_str()));
        assert_eq!(snapshot.items[0].state,q::QueueState::Running);
        assert!(!snapshot.available);
    }
    #[test]
    fn queue_requests_are_closed_and_reorder_destination_is_explicit() {
        let valid=serde_json::json!({"action":"reorder","context":id(),"requestId":id(),"expectedRevision":1,
            "queueId":id(),"beforeQueueId":null});
        assert!(serde_json::from_value::<ActionRequest>(valid.clone()).is_ok());
        let mut missing=valid.clone();missing.as_object_mut().unwrap().remove("beforeQueueId");
        assert!(serde_json::from_value::<ActionRequest>(missing).is_err());
        for field in ["script","allowWrite","workspace","env"] {
            let mut extra=valid.clone();extra[field]=serde_json::json!(true);
            assert!(serde_json::from_value::<ActionRequest>(extra).is_err());
        }
        let mut malformed=valid;malformed["beforeQueueId"]=serde_json::json!(7);
        assert!(serde_json::from_value::<ActionRequest>(malformed).is_err());
    }
    #[test]
    fn duplicate_context_and_wrong_revision_types_are_rejected() {
        let context=id();
        assert!(serde_json::from_str::<ContextToken>(&format!("{{\"context\":\"{context}\",\"context\":\"{context}\"}}")).is_err());
        for revision in [serde_json::json!(-1),serde_json::json!(0.5),serde_json::json!("1")] {
            let input=serde_json::json!({"action":"cancel","context":id(),"requestId":id(),"queueId":id(),"expectedRevision":revision});
            assert!(serde_json::from_value::<ActionRequest>(input).is_err());
        }
    }
    #[test]
    fn external_windows_cannot_acquire_queue_context() {
        let url=tauri::Url::parse("https://example.com/").unwrap();
        assert!(!crate::local_pairing_address("main",&url));
        let local=tauri::Url::parse("tauri://localhost/").unwrap();
        assert!(crate::local_pairing_address("main",&local));
        assert!(!crate::local_pairing_address("browser-page",&local));
    }

    async fn wait_for(service: &PiWorkService, predicate: impl Fn() -> bool) {
        let timeout = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !predicate() {
            assert!(std::time::Instant::now() < timeout, "fixture did not reach the observed state; runs={} queue={}",
                serde_json::json!(service.list().iter().map(|run| serde_json::json!({"prompt":run.prompt,"status":run.status,
                    "outcome":run.outcome,"continuation":run.continuation})).collect::<Vec<_>>()),
                serde_json::json!(service.queue.lock().unwrap().store.snapshot()));
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let _ = service;
    }

    async fn fixture(first_prompt: &str) -> (crate::agent_tools::TestWorkspace, PiWorkService,
        Arc<tokio::sync::Mutex<crate::dev_cli::DevRuns>>, PiRunState, String) {
        let path=std::env::temp_dir().join(format!("hub-queue-fixture-{}",id()));
        std::fs::create_dir(&path).unwrap();
        let root=path.canonicalize().unwrap();
        let workspace=crate::agent_tools::TestWorkspace{path:root.clone()};
        let script=root.join("queue-fixture.cjs");
        std::fs::write(&script,r#"
const fs=require('node:fs'),readline=require('node:readline');
const prompt=process.argv[3],input=readline.createInterface({input:process.stdin});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
emit({type:'hello',proto:1,model:'fixture/queue',activeTools:[],tools:[]});
input.on('line',line=>{
 const frame=JSON.parse(line);if(frame.type!=='session')return;
 const entries=frame.entries,markers=entries.filter(row=>row.type==='marker').map(row=>row.text);
 const required=prompt==='two'?['one']:prompt==='three'?['one','two']:[];
 if(required.some(value=>!markers.includes(value))){emit({type:'agent_done',ok:false});input.close();process.stdin.destroy();return;}
 const finish=()=>{
  if(prompt!=='no-checkpoint')emit({type:'checkpoint',entries:[...(entries.length?entries:[{type:'session',id:'queue-fixture',hubEngine:'thin'}]),{type:'marker',text:prompt}]});
  emit({type:'agent_done',ok:true});input.close();process.stdin.destroy();
 };
 if(prompt==='one'||prompt==='two'||prompt==='no-checkpoint'){
  const timer=setInterval(()=>{if(fs.existsSync('release-'+prompt)){clearInterval(timer);finish();}},10);
 }else finish();
});
"#).unwrap();
        let service=PiWorkService { checkpoints:Some(crate::checkpoint::CheckpointStore::test(root.join("saved"),[31;32])),
            queue_fixture:Some(TestFixture{workspace:root.clone(),script:script.clone()}),..PiWorkService::default() };
        let leases=Arc::new(tokio::sync::Mutex::new(crate::dev_cli::DevRuns::default()));
        let spec=super::super::SidecarSpec { program:"node".into(),args:vec![super::super::non_verbatim(script.clone()).to_string_lossy().into_owned(),"fixture/queue".into(),first_prompt.into()],
            workspace:root.clone(),env:vec![("PI_SIDECAR_SESSION".into(),"1".into()),("PI_WORK_ENGINE".into(),"thin".into())] };
        let first=service.start_core(spec,"fixture/queue".into(),first_prompt.into(),false,false,false,false,None,&leases,None,None).await.unwrap();
        wait_for(&service,||service.status(&first.id).is_some_and(|run|run.hello.is_some()&&run.status=="running")).await;
        let context=q::Context { token:id(),workspace:super::super::non_verbatim(root).to_string_lossy().into_owned(),
            model:"fixture/queue".into(),engine:WorkEngine::Thin,permissions:q::Permissions{allow_write:false,allow_exec:false,allow_http:false} };
        service.queue.lock().unwrap().store.set_context(Some(context.clone()),true).unwrap();
        (workspace,service,leases,first,context.token)
    }

    fn enqueue(service:&PiWorkService,leases:&Arc<tokio::sync::Mutex<crate::dev_cli::DevRuns>>,
        context:&str,anchor_run_id:&str,text:&str)->serde_json::Value {
        let expected_revision=service.queue.lock().unwrap().store.snapshot().revision;
        apply_action(service,leases,ActionRequest::Enqueue{context:context.into(),expected_revision,request_id:id(),
            anchor_run_id:anchor_run_id.into(),text:text.into()}).unwrap()
    }

    #[tokio::test]
    async fn real_fake_transport_drains_after_lease_and_retains_each_actual_checkpoint() {
        let (workspace,service,leases,first,context)=fixture("one").await;
        let cancelled=enqueue(&service,&leases,&context,&first.id,"cancel-me");
        let expected_revision=service.queue.lock().unwrap().store.snapshot().revision;
        apply_action(&service,&leases,ActionRequest::Cancel{context:context.clone(),expected_revision,request_id:id(),
            queue_id:cancelled["queueId"].as_str().unwrap().into()}).unwrap();
        let second=enqueue(&service,&leases,&context,&first.id,"two");
        assert_eq!(service.list().len(),1,"a reservation cannot start before its live anchor finishes");
        std::fs::write(workspace.path.join("release-one"),b"owned fixture").unwrap();
        wait_for(&service,||service.list().iter().any(|run|run.prompt=="two"&&run.status=="running")).await;
        let actual_second=service.list().into_iter().find(|run|run.prompt=="two").unwrap();
        assert_ne!(actual_second.id,first.id);
        assert_eq!(actual_second.continuation.resumed_from.as_deref(),Some(first.id.as_str()));
        let third=enqueue(&service,&leases,&context,&first.id,"three");
        let reservation=service.queue.lock().unwrap().store.snapshot().items.into_iter()
            .find(|item|item.queue_id==third["queueId"].as_str().unwrap()).unwrap();
        assert_eq!(reservation.anchor_run_id,actual_second.id,"late reservations must use the actual current run");
        std::fs::write(workspace.path.join("release-two"),b"owned fixture").unwrap();
        wait_for(&service,||service.list().iter().any(|run|run.prompt=="three"&&run.status=="done")).await;
        let actual_third=service.list().into_iter().find(|run|run.prompt=="three").unwrap();
        assert_eq!(actual_third.continuation.resumed_from.as_deref(),Some(actual_second.id.as_str()));
        assert!(actual_third.continuation.available);
        assert!(!actual_third.allow_write&&!actual_third.allow_exec&&!actual_third.allow_http);
        assert_eq!(service.list().len(),3);
        assert!(service.list().iter().all(|run|run.prompt!="cancel-me"));
        let snapshot=service.queue.lock().unwrap().store.snapshot();
        assert_eq!(snapshot.items.iter().find(|item|item.queue_id==second["queueId"].as_str().unwrap()).unwrap().native_run_id.as_deref(),Some(actual_second.id.as_str()));
        let proof=service.resume_checkpoint(&actual_third.id,&workspace.path).unwrap();
        assert!(proof.entries.to_string().contains("one")&&proof.entries.to_string().contains("two")&&proof.entries.to_string().contains("three"));
    }

    #[tokio::test]
    async fn missing_checkpoint_and_cancel_hold_instead_of_starting_a_new_process() {
        for cancel in [false,true] {
            let (workspace,service,leases,first,context)=fixture(if cancel{"one"}else{"no-checkpoint"}).await;
            enqueue(&service,&leases,&context,&first.id,"two");
            if cancel { service.cancel(&first.id,&leases).await.unwrap(); }
            else { std::fs::write(workspace.path.join("release-no-checkpoint"),b"owned fixture").unwrap(); }
            wait_for(&service,||service.queue.lock().unwrap().store.snapshot().items[0].state==q::QueueState::Held).await;
            assert_eq!(service.list().len(),1);
            assert!(service.queue.lock().unwrap().store.next_ready().is_none());
        }
    }
}

pub(super) fn validate_selected(service: &PiWorkService, context: &q::Context) -> Result<(), String> {
    if selected_workspace(service).ok().map(super::non_verbatim).is_some_and(|path| path.to_string_lossy() == context.workspace) {
        Ok(())
    } else { Err("pi_queue_stale".into()) }
}
