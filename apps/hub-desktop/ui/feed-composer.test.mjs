import test from 'node:test';import assert from 'node:assert/strict';import {createFeedComposer} from './feed-composer.mjs';
import {readFileSync,existsSync} from 'node:fs';import {createRequire} from 'node:module';import vm from 'node:vm';
const requestId='11111111-1111-4111-8111-111111111111',imageId='22222222-2222-4222-8222-222222222222',instant=Date.parse('2026-10-07T12:00:00.000Z');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};},tick=()=>new Promise(setImmediate);
const image=()=>({blob:new Blob(['image']),thumbnailBlob:new Blob(['thumbnail']),width:100,height:90,thumbnailWidth:50,thumbnailHeight:45});
function receipt(input,source,{status='scheduled'}={}){
 const common={viewerId:source.viewer,clientRequestId:input.clientRequestId};
 if(input.scheduledAt)return{...common,post:null,scheduled:{id:'scheduled-id',body:input.body,audience:input.audience,scheduledAt:input.scheduledAt,status}};
 return{...common,post:{id:'post-id',body:input.body,audience:input.audience,createdAt:'2026-10-07T12:00:00.000Z',authorName:'Synthetic',authorHandle:null,authorProfileId:source.viewer,avatarUrl:null,replyCount:0,repostCount:0,likeCount:0,likedByViewer:false,bookmarkedByViewer:false,viewerRepostId:null,images:input.imageIds.map(id=>({id,url:'/api/images/'+id,width:100,height:90,altText:''})),tags:[],referenced:null},scheduled:null};
}
function fixture(){
 const f={source:{origin:'http://127.0.0.1:3020',device:'device-a',viewer:'viewer-a',generation:{}},active:true,viewEpoch:{},revision:{},draft:{body:' original ',images:[],audience:'public',scheduledAt:''},uploads:[],submissions:[],lookups:[],acks:[],statuses:[],uuidCalls:0,capture:null,upload:null,submit:null,lookup:null};
 const sameScope=source=>['origin','device','viewer','generation'].every(key=>source[key]===f.source[key]);
 f.controller=createFeedComposer({captureScope:()=>f.capture?f.capture():Promise.resolve({...f.source}),scopeCurrent:sameScope,current:source=>{if(f.currentError)throw Error('synthetic_current');return f.active&&sameScope(source);},getDraft:()=>f.draft,getDraftRevision:()=>f.revision,getViewRevision:()=>f.viewEpoch,
 upload:async(payload,source)=>{f.uploads.push({payload,source});return f.upload?f.upload(payload,source):{image:{id:imageId}};},submit:async(payload,source)=>{f.submissions.push({payload,source});return f.submit?f.submit(payload,source):receipt(payload,source);},lookup:async(payload,source)=>{f.lookups.push({payload,source});return f.lookup?f.lookup(payload,source):{viewerId:source.viewer,clientRequestId:payload.clientRequestId,post:null,scheduled:null};},
 onAck:(value,info)=>f.acks.push({value,info}),onStatus:value=>f.statuses.push(value),randomUUID:()=>{f.uuidCalls++;return f.nextUUID??requestId;},now:()=>instant});return f;
}
test('busy and immutable draft reserve synchronously before fresh scope; double submit creates one UUID/POST',async()=>{
 const f=fixture(),gate=deferred();f.capture=()=>gate.promise;const pending=f.controller.send();assert.equal(f.controller.status().busy,true);assert.equal(await f.controller.send(),false);assert.equal(f.uuidCalls,1);
 f.draft.body='new draft';f.draft.audience='followers';f.revision={};gate.resolve({...f.source});assert.equal(await pending,true);assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].payload.body,'original');assert.equal(f.submissions[0].payload.audience,'public');assert.equal(f.acks[0].info.clearDraft,false);
});
test('deferred image and thumbnail arrayBuffer scope/origin changes produce zero upload and POST',async()=>{
 for(const step of ['image','thumbnail'])for(const change of ['viewer','origin']){
  const f=fixture(),gate=deferred(),item=image();item[step==='image'?'blob':'thumbnailBlob']={arrayBuffer:()=>gate.promise};f.draft.images=[item];const pending=f.controller.send();await tick();f.source={...f.source,[change]:change==='origin'?'http://127.0.0.1:3030':'viewer-b',generation:{}};gate.resolve(new Uint8Array([1]).buffer);assert.equal(await pending,false);assert.equal(f.uploads.length,0);assert.equal(f.submissions.length,0);assert.equal(f.acks.length,0);assert.equal(f.controller.status().state,'scope_changed');
 }
});
test('upload captures flat Native scope and late actor/view change cannot publish or acknowledge',async()=>{
 const f=fixture(),gate=deferred();f.draft.images=[image()];f.upload=()=>gate.promise;const pending=f.controller.send();await tick();assert.deepEqual(Object.keys(f.uploads[0].payload).sort(),['image','thumbnail','width','height','thumbnailWidth','thumbnailHeight','altText','expectedDeviceId','expectedOrigin','expectedViewerId'].sort());assert.equal(f.uploads[0].payload.expectedViewerId,'viewer-a');
 f.source={...f.source,generation:{}};gate.resolve({image:{id:imageId}});assert.equal(await pending,false);assert.equal(f.submissions.length,0);assert.equal(f.acks.length,0);
});
test('unknown upload retains draft and blocks new upload, POST, lookup and explicit retry',async()=>{
 const f=fixture();f.draft.images=[image()];f.upload=()=>{throw Error('timeout');};assert.equal(await f.controller.send(),false);assert.equal(f.controller.status().state,'upload_unknown');assert.equal(await f.controller.retry(),false);assert.equal(await f.controller.send(),false);assert.equal(await f.controller.recheck(),false);assert.equal(f.uploads.length,1);assert.equal(f.submissions.length,0);assert.equal(f.lookups.length,0);assert.equal(f.draft.images.length,1);
});
test('POST unknown then lookup found confirms once, without re-upload or duplicate send',async()=>{
 const f=fixture();f.draft.images=[image()];f.submit=()=>{throw Error('feed_operation_unknown');};await f.controller.send();const original=f.submissions[0];f.lookup=()=>receipt(original.payload,original.source);
 assert.equal(await f.controller.retry(),false);assert.equal(await f.controller.recheck(),true);assert.equal(await f.controller.recheck(),false);assert.equal(f.uploads.length,1);assert.equal(f.submissions.length,1);assert.equal(f.acks.length,1);assert.equal(f.acks[0].info.clearDraft,true);assert.deepEqual(f.lookups[0].payload,{clientRequestId:requestId,kind:'post'});
});
test('only successful empty lookup permits explicit same UUID/content retry; pending double retry is one POST',async()=>{
 const f=fixture();f.draft.images=[image()];f.submit=()=>{throw Error('timeout');};await f.controller.send();const first=f.submissions[0].payload;assert.equal(await f.controller.retry(),false);await f.controller.recheck();assert.equal(f.controller.status().canRetry,true);
 f.draft={body:'new draft',audience:'followers',images:[],scheduledAt:''};f.revision={};const gate=deferred();f.submit=()=>gate.promise;const pending=f.controller.retry();assert.equal(await f.controller.retry(),false);gate.resolve(receipt(first,f.source));assert.equal(await pending,true);assert.deepEqual(f.submissions[1].payload,first);assert.equal(f.uploads.length,1);assert.equal(f.uuidCalls,1);assert.equal(f.acks[0].info.clearDraft,false);
});
test('lookup failure/mismatched actor/content/request/unknown field retain unknown and never allow retry',async()=>{
 for(const corrupt of [()=>{throw Error('timeout');},value=>({...value,viewerId:'viewer-b'}),value=>({...value,clientRequestId:imageId}),value=>({...value,extra:true}),value=>({...value,post:{...value.post,body:'other'}}),value=>({...value,post:{...value.post,audience:'followers'}})]){
  const f=fixture();f.submit=()=>{throw Error('timeout');};await f.controller.send();const found=receipt(f.submissions[0].payload,f.source);f.lookup=()=>corrupt(found);assert.equal(await f.controller.recheck(),false);assert.equal(f.controller.status().state,'unknown');assert.equal(await f.controller.retry(),false);assert.equal(f.acks.length,0);
 }
});
test('schedule intent is frozen before scope wait and terminal schedules are distinguished',async()=>{
 for(const status of ['scheduled','published','cancelled','failed']){
  const f=fixture(),gate=deferred();f.draft.scheduledAt='2026-10-07T13:00:00.000Z';f.capture=()=>gate.promise;const pending=f.controller.send();f.draft.scheduledAt='';f.draft.images=[image()];f.revision={};gate.resolve({...f.source});await pending;
  assert.equal(f.submissions[0].payload.scheduledAt,'2026-10-07T13:00:00.000Z');assert.equal(f.uploads.length,0);assert.equal(f.acks[0].info.kind,'scheduled');
  const next=fixture();next.draft.scheduledAt='2026-10-07T13:00:00.000Z';next.submit=(input,source)=>receipt(input,source,{status});assert.equal(await next.controller.send(),true);assert.equal(next.acks[0].info.outcome,status);assert.equal(next.acks[0].info.clearDraft,['scheduled','published'].includes(status));
 }
});
test('late POST success after scope invalidation or destroy paints and clears nothing',async()=>{
 for(const end of ['invalidate','destroy']){
  const f=fixture(),gate=deferred();f.submit=()=>gate.promise;const pending=f.controller.send();await tick();const old=f.submissions[0];f.controller[end]();const n=f.statuses.length;gate.resolve(receipt(old.payload,old.source));assert.equal(await pending,false);assert.equal(f.acks.length,0);assert.equal(f.statuses.length,n);
 }
});
test('implied widths: 500 UTF16 accepted, 501/unpaired/NUL and image count/bytes are rejected before IPC',async()=>{
 const f=fixture();f.draft.body='😀'.repeat(250);assert.equal(await f.controller.send(),true);
 for(const body of ['😀'.repeat(250)+'a','\ud800','a\0b']){const next=fixture();next.draft.body=body;assert.equal(await next.controller.send(),false);assert.equal(next.submissions.length,0);}
 const excess=fixture();excess.draft.images=Array.from({length:5},image);assert.equal(await excess.controller.send(),false);assert.equal(excess.uploads.length,0);
 for(const step of ['blob','thumbnailBlob']){const next=fixture(),item=image();item[step]={arrayBuffer:async()=>new ArrayBuffer((step==='blob'?2*1024*1024:512*1024)+1)};next.draft.images=[item];assert.equal(await next.controller.send(),false);assert.equal(next.uploads.length,0);assert.equal(next.submissions.length,0);}
});
test('draft content comparison protects edits even when a root revision seam was missed',async()=>{
 const f=fixture(),gate=deferred();f.submit=()=>gate.promise;const pending=f.controller.send();await tick();const sent=f.submissions[0];f.draft.body='changed without revision event';gate.resolve(receipt(sent.payload,sent.source));assert.equal(await pending,true);assert.equal(f.acks[0].info.clearDraft,false);
});
test('known scope rejection invalidates IDs; request conflict requires lookup; malformed xor ACK is unknown',async()=>{
 const scope=fixture();scope.submit=()=>{throw Error('feed_operation_scope_conflict');};assert.equal(await scope.controller.send(),false);assert.equal(scope.controller.status().state,'scope_changed');assert.equal(scope.acks.length,0);
 const conflict=fixture();conflict.submit=()=>{throw Error('feed_operation_request_conflict');};await conflict.controller.send();assert.equal(conflict.controller.status().state,'request_conflict');assert.equal(await conflict.controller.retry(),false);assert.equal(conflict.submissions.length,1);
 const malformed=fixture();malformed.submit=(input,source)=>({...receipt(input,source),scheduled:{}});await malformed.controller.send();assert.equal(malformed.controller.status().state,'unknown');assert.equal(malformed.acks.length,0);
});
test('view departure keeps unknown operation and uploaded IDs; same scope reentry only permits explicit lookup',async()=>{
 const f=fixture(),gate=deferred();f.draft.images=[image()];f.submit=()=>gate.promise;const pending=f.controller.send();await tick();const saved=f.submissions[0];f.active=false;const n=f.statuses.length;gate.resolve(receipt(saved.payload,saved.source));assert.equal(await pending,false);assert.equal(f.acks.length,0);assert.equal(f.statuses.length,n);assert.equal(f.controller.status().state,'unknown');
 assert.equal(await f.controller.retry(),false);assert.equal(await f.controller.recheck(),false);assert.equal(f.lookups.length,0);f.active=true;f.controller.refresh();assert.equal(await f.controller.send(),false);f.lookup=()=>receipt(saved.payload,saved.source);assert.equal(await f.controller.recheck(),true);assert.equal(f.acks.length,1);assert.equal(f.uploads.length,1);assert.equal(f.submissions.length,1);
});
test('view departure during successful upload retains ID without POST; lookup then same attempt retry uses no second upload',async()=>{
 const f=fixture(),gate=deferred();f.draft.images=[image()];f.upload=()=>gate.promise;const pending=f.controller.send();await tick();f.active=false;gate.resolve({image:{id:imageId}});assert.equal(await pending,false);assert.equal(f.submissions.length,0);assert.equal(f.controller.status().state,'paused');f.active=true;await f.controller.recheck();assert.equal(f.controller.status().state,'not_found');assert.equal(await f.controller.retry(),true);assert.equal(f.uploads.length,1);assert.equal(f.submissions.length,1);
});
test('body NFKC/CRLF/trim profile and normalized width; UUID shape/nil boundary',async()=>{
 const f=fixture();f.draft.body='  Ａ\r\nＢ  ';await f.controller.send();assert.equal(f.submissions[0].payload.body,'A\nB');
 const wide=fixture();wide.draft.body='㍍'.repeat(126);assert.equal(await wide.controller.send(),false);assert.equal(wide.submissions.length,0);
 const emptyId=fixture();emptyId.draft.images=[image()];emptyId.upload=()=>({image:{id:'00000000-0000-0000-0000-000000000000'}});await emptyId.controller.send();assert.equal(emptyId.controller.status().state,'upload_unknown');assert.equal(emptyId.submissions.length,0);
});
test('leave and return during scope capture pauses; refresh does not replay; explicit read then retry is one POST',async()=>{
 const f=fixture(),gate=deferred();f.capture=()=>gate.promise;const pending=f.controller.send();f.viewEpoch={};f.controller.refresh();gate.resolve({...f.source});assert.equal(await pending,false);assert.equal(f.controller.status().state,'paused');assert.equal(f.submissions.length,0);f.controller.refresh();assert.equal(f.submissions.length,0);await f.controller.recheck();assert.equal(await f.controller.retry(),true);assert.equal(f.submissions.length,1);
});
test('current callback exception pauses and has no automatic replay',async()=>{
 const f=fixture();f.currentError=true;assert.equal(await f.controller.send(),false);assert.equal(f.controller.status().state,'paused');assert.equal(f.submissions.length,0);f.currentError=false;f.controller.refresh();assert.equal(f.submissions.length,0);await f.controller.recheck();assert.equal(await f.controller.retry(),true);
});
test('ACK compares image ID sets, rejects duplicates, and accepts authoritative alternate ordering',async()=>{
 const f=fixture(),other='33333333-3333-4333-8333-333333333333';f.draft.images=[image(),image()];f.upload=()=>({image:{id:f.uploads.length===1?imageId:other}});f.submit=(input,source)=>{const value=receipt(input,source);value.post.images.reverse();return value;};assert.equal(await f.controller.send(),true);assert.equal(f.acks.length,1);
});
function appFixture(t){
 const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom'),dom=new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8'),{url:'http://fixture.invalid/'}),document=dom.window.document;
 const actual=new URL('./app.js',import.meta.url),source=readFileSync(existsSync(actual)?actual:new URL('./integration/app.js',import.meta.url),'utf8');
 const slice=(start,end)=>{const from=source.indexOf(start),to=source.indexOf(end,from);assert.ok(from>=0&&to>from);return source.slice(from,to);};
 const mode=document.createElement('select');mode.id='composer-storage';for(const name of ['hub','node'])mode.append(new dom.window.Option(name,name));document.querySelector('#composer').append(mode);
 const composer={form:document.querySelector('#composer'),text:document.querySelector('#composer-text'),post:document.querySelector('#composer-post'),note:document.querySelector('#composer-note'),count:document.querySelector('#composer-count')};
 const calls=[],revoked=[],ctx={document,window:dom.window,currentView:'feed',homeAccountEpoch:{},feedComposerViewEpoch:{},feedComposer:null,selfProfileId:'viewer-a',desktopAccountLoaded:true,desktopAccount:{state:'registered',deviceId:'device-a',keyThumbprint:'synthetic'},composer,composerImages:[],composerImageStrip:document.querySelector('#composer-images'),composerImageAdd:document.querySelector('#composer-image-add'),composerImageInput:document.querySelector('#composer-image-input'),composerAudience:document.querySelector('#composer-audience'),composerScheduleAt:document.querySelector('#composer-schedule-at'),composerScheduledList:document.querySelector('#composer-scheduled-list'),nodeCalls:0,nodePostComposer:{mode,submit:()=>{ctx.nodeCalls++;return Promise.resolve(true);}},createFeedComposer,URL:class extends URL {static revokeObjectURL(value){revoked.push(value);}},feed:{list:document.querySelector('#feed-list'),state:document.querySelector('#feed-state')},setTimeout:()=>1,friendlyError:()=> 'synthetic_unavailable',postCard:post=>{const node=document.createElement('article');node.textContent=post.body;return node;},processComposerImage:async()=>({...image(),previewUrl:'blob:synthetic'})};
 ctx.invoke=async(command,args)=>{calls.push({command,args});if(command==='hub_origin')return'http://127.0.0.1:3020';if(command==='desktop_account_status')return ctx.desktopAccount;if(command==='hub_client'&&args.name==='me')return{profile:{id:ctx.selfProfileId}};if(command==='hub_upload_image')return{image:{id:imageId}};if(command==='hub_detail')return{viewerId:args.ids[2],clientRequestId:args.ids[3],post:null,scheduled:null};if(command==='hub_client_action'){if(ctx.send)return ctx.send(args);return receipt({body:args.text,audience:args.options.audience,imageIds:args.options.imageIds??[],scheduledAt:args.options.scheduledAt??null,clientRequestId:args.requestId},{viewer:args.options.expectedViewerId});}throw Error('synthetic_command');};
 const context=vm.createContext(ctx);vm.runInContext(slice('function homeAccountSnapshot()','function validHomeProfileId(')+slice('function renderComposerImages()','// 処理済み画像群')+slice('let feedImageEpoch=','// --- 本人の画面'),context);
 t.after(()=>dom.window.close());return{ctx,dom,document,composer,calls,revoked,submit:()=>composer.form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}))};
}
test('real app Hub handler reserves synchronously with scoped Native options and Node mode is exclusive',async t=>{
 const f=appFixture(t);f.composer.text.value=' first ';f.submit();f.submit();await tick();await tick();assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);const action=f.calls.find(call=>call.command==='hub_client_action');assert.equal(action.args.action,'create_post');assert.equal(action.args.text,'first');assert.equal(action.args.options.expectedViewerId,'viewer-a');assert.equal(action.args.options.expectedDeviceId,'device-a');assert.equal(action.args.options.expectedOrigin,'http://127.0.0.1:3020');assert.equal(f.composer.text.value,'');
 f.ctx.nodePostComposer.mode.value='node';f.composer.text.value='node draft';f.submit();assert.equal(f.ctx.nodeCalls,1);assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);
});
test('real app stale image processing revokes preview; account change clears Hub draft but leaves Node draft',async t=>{
 const f=appFixture(t),gate=deferred();f.ctx.processComposerImage=()=>gate.promise;Object.defineProperty(f.ctx.composerImageInput,'files',{configurable:true,value:[{}]});const pending=f.ctx.composerImageInput.onchange();f.ctx.homeAccountEpoch={};f.ctx.selfProfileId='viewer-b';f.ctx.desktopAccount={state:'registered',deviceId:'device-b',keyThumbprint:'synthetic-b'};f.composer.text.value='old';f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));assert.equal(f.composer.text.value,'');gate.resolve({...image(),previewUrl:'blob:stale'});await pending;assert.deepEqual(f.revoked,['blob:stale']);assert.equal(f.ctx.composerImages.length,0);assert.equal(f.calls.some(call=>call.command==='hub_upload_image'),false);
 f.ctx.nodePostComposer.mode.value='node';f.composer.text.value='node draft';f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));assert.equal(f.composer.text.value,'node draft');
});
test('real app late ACK keeps new draft and unknown lookup uses fixed five-ID receipt path',async t=>{
 const f=appFixture(t),gate=deferred();f.composer.text.value='original';f.ctx.send=()=>gate.promise;f.submit();await tick();await tick();const action=f.calls.find(call=>call.command==='hub_client_action').args;f.composer.text.value='new draft';f.composer.text.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));gate.resolve(receipt({body:action.text,audience:action.options.audience,imageIds:[],scheduledAt:null,clientRequestId:action.requestId},{viewer:'viewer-a'}));await tick();assert.equal(f.composer.text.value,'new draft');
 f.ctx.send=()=>{throw Error('feed_operation_unknown');};f.submit();await tick();await tick();await f.ctx.feedComposer.recheck();const lookup=f.calls.find(call=>call.command==='hub_detail');assert.equal(lookup.args.name,'feed_post_request');assert.deepEqual(Array.from(lookup.args.ids).slice(0,3),['device-a','http://127.0.0.1:3020','viewer-a']);assert.equal(lookup.args.ids.length,5);assert.equal(lookup.args.ids[4],'post');
});
test('explicit upload-only abandonment discards IDs with no replay; post unknown cannot be abandoned',async()=>{
 const f=fixture();f.draft.images=[image()];f.upload=()=>{throw Error('timeout');};await f.controller.send();assert.equal(f.submissions.length,0);assert.equal(f.controller.abandonUpload(),true);assert.equal(f.uploads.length,1);assert.equal(f.submissions.length,0);assert.equal(f.draft.body,' original ');f.draft.images=[];f.nextUUID=imageId;assert.equal(await f.controller.send(),true);assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].payload.clientRequestId,imageId);
 const posted=fixture();posted.submit=()=>{throw Error('timeout');};await posted.controller.send();assert.equal(posted.controller.abandonUpload(),false);assert.equal(posted.controller.status().state,'unknown');assert.equal(posted.submissions.length,1);
});
test('real app image decoding from an old feed visit is dropped after leave and return',async t=>{
 const f=appFixture(t),gate=deferred();f.ctx.processComposerImage=()=>gate.promise;f.composer.text.value='current draft';Object.defineProperty(f.ctx.composerImageInput,'files',{configurable:true,value:[{}]});const pending=f.ctx.composerImageInput.onchange();f.ctx.currentView='ai';f.ctx.feedComposerViewEpoch={};f.ctx.currentView='feed';f.ctx.feedComposerViewEpoch={};gate.resolve({...image(),previewUrl:'blob:old-visit'});await pending;assert.equal(f.ctx.composerImages.length,0);assert.deepEqual(f.revoked,['blob:old-visit']);assert.equal(f.composer.text.value,'current draft');assert.equal(f.composer.post.disabled,false);assert.equal(f.calls.some(call=>call.command==='hub_upload_image'||call.command==='hub_client_action'),false);
});
