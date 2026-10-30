import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {communityChannelPolicyControls} from './community-channel-policy.mjs';
const cid='c1',time='2026-10-03T00:00:00.000Z';
const channel=(overrides={})=>({id:'ch1',name:'<img>議論\nチャンネル',slowmodeSeconds:5,archivedAt:null,...overrides});
const page=(offset=0,overrides={})=>({communityId:cid,viewerId:'manager',role:'owner',channels:[channel({id:'ch'+(offset+1)})],offset,hasMore:offset===0,...overrides});
const reply=(args,changes={})=>({communityId:cid,channel:channel({id:args.options.channelId,slowmodeSeconds:args.options.slowmodeSeconds??args.options.expectedSlowmodeSeconds,archivedAt:args.options.archived?time:null}),receipt:{auditId:args.requestId,action:args.action==='community_channel_archive'?'set_channel_archived':'channel_controls',targetId:args.options.channelId,confirmedAt:time,replayed:false},...changes});
const button=(root,label)=>[...root.querySelectorAll('button')].find(n=>n.textContent===label);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const entry=state=>state.channelPolicies?.[JSON.stringify([cid])];
function fixture(options={},state={}){
  const dom=new JSDOM(''),calls=[],controller=communityChannelPolicyControls(dom.window.document,{communityId:cid,state,invoke:async(name,args)=>{calls.push({name,args});return name==='hub_detail'?page(Number(args.ids[1])):reply(args);},...options});dom.window.document.body.append(controller.root);return{dom,calls,state,controller,root:controller.root};
}
async function open(view){view.root.open=true;await view.root.ontoggle();await view.controller.ready;}
function draft(view,note='  ＡＢＣＤＥ  ',seconds=30){const reason=view.root.querySelector('textarea');reason.value=note;reason.dispatchEvent(new view.dom.window.Event('input'));const choice=view.root.querySelector('[aria-label="変更後の投稿間隔"]');choice.value=seconds;choice.dispatchEvent(new view.dom.window.Event('change'));}
function close(view){view.controller.dispose();view.dom.window.close();}

test('collapsed controls read only on first open; fixed page read is deduplicated, text is inert and moderator has no archive action',async()=>{
  const view=fixture();await view.controller.ready;assert.equal(view.calls.length,0);await open(view);await view.root.ontoggle();assert.deepEqual(view.calls,[{name:'hub_detail',args:{name:'community_channel_policy_page',ids:[cid,'0']}}]);assert.equal(view.root.querySelector('img'),null);assert.match(view.root.textContent,/<img>議論\nチャンネル/);assert.ok(button(view.root,'アーカイブを確認'));close(view);
  const mod=fixture({invoke:async()=>page(0,{role:'moderator'})});await open(mod);assert.equal(button(mod.root,'アーカイブを確認'),undefined);assert.ok(button(mod.root,'投稿間隔の変更を確認'));assert.match(mod.root.textContent,/オーナーだけ/);close(mod);
});

test('paging failure and mismatched payload preserve position and stale rows but block mutation; explicit retry reaches the requested page',async()=>{
  let mode='network';const calls=[],view=fixture({invoke:async(name,args)=>{calls.push(args);const offset=Number(args.ids[1]);if(offset===0)return page();if(mode==='network')throw Error('offline');const value=page(offset);if(mode==='offset')value.offset=0;if(mode==='community')value.communityId='other';if(mode==='length')value.channels=Array(21).fill(channel());return value;}});await open(view);
  await button(view.root,'次の20件').onclick();assert.equal(entry(view.state).offset,0);assert.match(view.root.textContent,/offline/);assert.equal(button(view.root,'投稿間隔の変更を確認').disabled,true);
  for(mode of ['offset','community','length']){await button(view.root,'設定を再読み込み').onclick();assert.equal(entry(view.state).offset,0);assert.match(view.root.textContent,/設定を確認できません/);assert.match(view.root.textContent,/<img>議論/);}
  mode='success';await button(view.root,'設定を再読み込み').onclick();assert.equal(entry(view.state).offset,20);assert.equal(calls.at(-1).ids[1],'20');assert.equal(button(view.root,'次の20件').disabled,true);assert.equal(button(view.root,'前の20件').disabled,false);close(view);
});

test('preview normalizes reasons and freezes exact current settings before one explicit save; failed reread keeps saved lock and current difference',async()=>{
  const writes=[],pending=deferred();let reads=0;const view=fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;if(reads===1)return page();throw Error('read offline');}writes.push(args);await pending.promise;return reply(args,{channel:channel({slowmodeSeconds:60})});}});await open(view);draft(view);button(view.root,'投稿間隔の変更を確認').click();assert.equal(writes.length,0);assert.match(view.root.querySelector('[aria-label="チャンネル設定の確認"]').textContent,/5秒.*30秒.*ABCDE/);
  const save=button(view.root,'確認して変更を保存');save.click();save.click();await tick();assert.equal(writes.length,1);assert.deepEqual(writes[0].options,{channelId:'ch1',note:'ABCDE',expectedSlowmodeSeconds:5,expectedArchivedAt:null,slowmodeSeconds:30});assert.match(writes[0].requestId,/^[a-f0-9-]{36}$/);pending.resolve();await tick();assert.match(view.root.textContent,/変更は保存済み/);assert.match(view.root.textContent,/現在の設定は確認した変更内容と異なります/);assert.equal(button(view.root,'同じ変更の保存結果を確認'),undefined);assert.equal(button(view.root,'別の設定を変更').disabled,true);await save.onclick();assert.equal(writes.length,1);close(view);
});

test('unknown result preserves exact request and expected values over dispose/remount, and replay acknowledgement may return newer current settings',async()=>{
  const state={},writes=[];let fail=true,reads=0;const invoke=async(name,args)=>{if(name==='hub_detail'){reads++;return page(0,{channels:[channel({slowmodeSeconds:reads>1?60:5})]});}writes.push(args);if(fail)throw Error('lost response');const value=reply(args,{channel:channel({slowmodeSeconds:60})});value.receipt.replayed=true;return value;};
  const first=fixture({invoke},state);await open(first);draft(first,'変更理由です');button(first.root,'投稿間隔の変更を確認').click();await button(first.root,'確認して変更を保存').onclick();const original=writes[0];assert.equal(button(first.root,'編集に戻る'),undefined);first.controller.dispose();
  const returned=fixture({invoke},state);await returned.controller.ready;assert.ok(button(returned.root,'同じ変更の保存結果を確認'));assert.equal(returned.root.querySelector('textarea'),null);fail=false;await button(returned.root,'同じ変更の保存結果を確認').onclick();assert.deepEqual(writes[1],original);assert.equal(writes[1].options.expectedSlowmodeSeconds,5);assert.match(returned.root.textContent,/変更は保存済み/);assert.match(returned.root.textContent,/再適用しません/);assert.equal(writes.length,2);close(returned);first.dom.window.close();
});

test('wrong response identity, receipt, enum or timestamp never marks saved and retries keep exact operation',async()=>{
  const changes=[v=>({...v,communityId:'other'}),v=>({...v,channel:{...v.channel,id:'wrong'}}),v=>({...v,channel:{...v.channel,slowmodeSeconds:7}}),v=>({...v,channel:{...v.channel,archivedAt:'bad'}}),v=>({...v,receipt:{...v.receipt,auditId:crypto.randomUUID()}}),v=>({...v,receipt:{...v.receipt,targetId:'wrong'}}),v=>({...v,receipt:{...v.receipt,action:'other'}}),v=>({...v,receipt:{...v.receipt,confirmedAt:'bad'}}),v=>({...v,receipt:{...v.receipt,replayed:'yes'}})];
  for(const change of changes){const writes=[],view=fixture({invoke:async(name,args)=>{if(name==='hub_detail')return page();writes.push(args);return change(reply(args));}});await open(view);draft(view);button(view.root,'投稿間隔の変更を確認').click();await button(view.root,'確認して変更を保存').onclick();assert.equal(entry(view.state).saved,undefined);assert.match(view.root.textContent,/保存結果/);await button(view.root,'同じ変更の保存結果を確認').onclick();assert.deepEqual(writes[0],writes[1]);close(view);}
});

test('confirmed409 after an unknown save keeps the old operation until fresh read and explicit local close; new confirmation uses fresh expected settings',async()=>{
  const writes=[];let reads=0;const view=fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;return page(0,{channels:[channel({slowmodeSeconds:reads>1?60:5})]});}writes.push(args);throw Error(writes.length===1?'network':'community_channel_policy_rejected:409:設定が変更されています');}});await open(view);draft(view);button(view.root,'投稿間隔の変更を確認').click();await button(view.root,'確認して変更を保存').onclick();await button(view.root,'同じ変更の保存結果を確認').onclick();assert.deepEqual(writes[0],writes[1]);assert.equal(button(view.root,'現在の設定を確認して操作を閉じる'),undefined);assert.equal(view.root.querySelector('textarea'),null);await button(view.root,'設定を再読み込み').onclick();const local=button(view.root,'現在の設定を確認して操作を閉じる');assert.ok(local);assert.match(view.root.textContent,/以前の操作の保存結果は確定できません/);local.click();assert.equal(writes.length,2);assert.ok(view.root.querySelector('textarea'));draft(view,'新しい変更理由');button(view.root,'投稿間隔の変更を確認').click();const operation=entry(view.state).operation;assert.notEqual(operation.requestId,writes[0].requestId);assert.equal(operation.options.expectedSlowmodeSeconds,60);assert.equal(writes.length,2);close(view);
});

test('owner archive and unarchive require reason and preview, preserving exact snapshot and receipt action',async()=>{
  for(const archivedAt of [null,time]){const writes=[];let saved=false;const view=fixture({invoke:async(name,args)=>{if(name==='hub_detail')return page(0,{channels:[channel({archivedAt:saved?(archivedAt?null:time):archivedAt})]});writes.push(args);saved=true;return reply(args);}});await open(view);draft(view,'アーカイブ変更理由');button(view.root,archivedAt?'アーカイブ解除を確認':'アーカイブを確認').click();assert.equal(writes.length,0);assert.match(view.root.textContent,/アーカイブ/);await button(view.root,'確認して変更を保存').onclick();assert.equal(writes[0].action,'community_channel_archive');assert.equal(writes[0].options.archived,!archivedAt);assert.equal(writes[0].options.expectedArchivedAt,archivedAt);assert.equal(writes[0].options.expectedSlowmodeSeconds,5);assert.equal(entry(view.state).saved.receipt.action,'set_channel_archived');close(view);}
});

test('pending save syncs after return, while account invalidation after disposal rejects a late result and preserves unrelated state',async()=>{
  const pending=deferred(),writes=[],state={otherDraft:'KEEP'},invoke=async(name,args)=>{if(name==='hub_detail')return page();writes.push(args);return pending.promise;};
  const first=fixture({invoke},state);await open(first);draft(first);button(first.root,'投稿間隔の変更を確認').click();button(first.root,'確認して変更を保存').click();await tick();first.controller.dispose();const old=first.root.textContent;
  const returned=fixture({invoke},state);await returned.controller.ready;assert.equal(button(returned.root,'同じ変更の保存結果を確認').disabled,true);pending.resolve(reply(writes[0]));await tick();assert.match(returned.root.textContent,/保存済み/);assert.equal(writes.length,1);assert.equal(first.root.textContent,old);close(returned);first.dom.window.close();
  const delayed=deferred(),older=fixture({invoke:async(name,args)=>name==='hub_detail'?page():delayed.promise},state);await older.controller.ready;button(older.root,'別の設定を変更').click();draft(older);button(older.root,'投稿間隔の変更を確認').click();const operation=entry(state).operation;button(older.root,'確認して変更を保存').click();await tick();older.controller.dispose();older.dom.window.dispatchEvent(new older.dom.window.Event('hub-account-changed'));delayed.resolve(reply({action:'community_channel_slowmode',requestId:operation.requestId,options:operation.options}));await tick();assert.deepEqual(state.channelPolicies,{});assert.equal(state.otherDraft,'KEEP');older.dom.window.close();
});

test('read authority loss erases names and input; isCurrent false and mismatched viewer cannot restore or execute old state',async()=>{
  let reads=0,current=true;const state={},view=fixture({isCurrent:()=>current,invoke:async()=>{reads++;if(reads===1)return page();throw Error('ハブが 403 を返しています');}},state);await open(view);draft(view,'PRIVATE_NOTE');await button(view.root,'設定を再読み込み').onclick();assert.doesNotMatch(view.root.textContent,/<img>議論|PRIVATE_NOTE/);assert.doesNotMatch(JSON.stringify(state),/<img>議論|PRIVATE_NOTE/);assert.equal(view.root.querySelector('textarea'),null);current=false;await button(view.root,'設定を再読み込み').onclick();assert.deepEqual(state.channelPolicies,{});close(view);
  let actorReads=0;const changed=fixture({invoke:async()=>page(0,{viewerId:actorReads++?'other':'manager'})});await open(changed);await button(changed.root,'設定を再読み込み').onclick();assert.deepEqual(changed.state.channelPolicies,{});assert.match(changed.root.textContent,/接続が変わりました/);close(changed);
});

test('malformed catalog fields, duplicate channels, size bounds and invalid target never expose writable controls',async()=>{
  const invalid=[page(0,{role:'member'}),page(0,{viewerId:'x\n'}),page(0,{channels:[channel({id:'x'.repeat(101)})]}),page(0,{channels:[channel({name:'x'.repeat(51)})]}),page(0,{channels:[channel({name:'\ud800'})]}),page(0,{channels:[channel({slowmodeSeconds:1})]}),page(0,{channels:[channel({archivedAt:'invalid'})]}),page(0,{channels:[channel(),channel()]}),page(0,{channels:Array(21).fill(channel())}),page(20),page(0,{hasMore:1}),{...page(),extra:'x'.repeat(128*1024)}];
  for(const value of invalid){const view=fixture({invoke:async()=>value});await open(view);assert.equal(view.root.querySelector('textarea'),null);assert.match(view.root.textContent,/設定を確認できません/);close(view);}
  const target=fixture({communityId:'x'.repeat(101)});await open(target);assert.equal(target.calls.length,0);assert.equal(target.root.querySelector('textarea'),null);close(target);
});

test('normalization uses UTF16 limits and enum validation; invalid drafts cannot prepare or send and editing before send expires UUID',async()=>{
  for(const [reason,seconds] of [['    ',30],['ＡＢＣＤ',30],['😀'.repeat(501),30],['\ud800reason',30],['valid reason',7]]){const view=fixture();await open(view);draft(view,reason,seconds);button(view.root,'投稿間隔の変更を確認').click();assert.equal(entry(view.state).operation,undefined);assert.equal(view.calls.length,1);close(view);}
  const view=fixture();await open(view);draft(view,'  '+ '😀'.repeat(500)+'  ');button(view.root,'投稿間隔の変更を確認').click();const first=entry(view.state).operation;assert.equal(first.options.note.length,1000);button(view.root,'編集に戻る').click();draft(view,'別の変更理由です');button(view.root,'投稿間隔の変更を確認').click();assert.notEqual(entry(view.state).operation.requestId,first.requestId);assert.equal(view.calls.length,1);close(view);
});

test('explicit reader clear during pending acknowledgement retains saved receipt but never restores channel names or notifies parent before reauthorization',async()=>{
  const pending=deferred(),changed=[],writes=[];let reads=0;const view=fixture({onChanged:value=>changed.push(value),invoke:async(name,args)=>{if(name==='hub_detail'){reads++;if(reads===1)return page();throw Error('ハブが 403 を返しています');}writes.push(args);return pending.promise;}});await open(view);draft(view);button(view.root,'投稿間隔の変更を確認').click();button(view.root,'確認して変更を保存').click();await tick();view.controller.clearReader();assert.doesNotMatch(view.root.textContent,/<img>議論/);pending.resolve(reply(writes[0]));await tick();assert.match(view.root.textContent,/変更は保存済み/);assert.doesNotMatch(view.root.textContent,/<img>議論/);assert.doesNotMatch(JSON.stringify(view.state),/<img>議論/);assert.equal(entry(view.state).saved.requestId,writes[0].requestId);assert.equal(changed.length,0);assert.equal(writes.length,1);close(view);
});

test('timestamp controls and width bound reject metadata, and unsafe page arithmetic never reaches invoke',async()=>{
  for(const archivedAt of [time+'\n',time+'\u0000',' '.repeat(65)+time,'\ud800'+time]){const view=fixture({invoke:async()=>page(0,{channels:[channel({archivedAt})]})});await open(view);assert.equal(view.root.querySelector('textarea'),null);assert.match(view.root.textContent,/設定を確認できません/);close(view);}
  const state={channelPolicies:{[JSON.stringify([cid])]:{open:true,offset:9007199254740980}}},unsafe=fixture({},state);await unsafe.controller.ready;assert.equal(unsafe.calls.length,0);assert.equal(unsafe.root.querySelector('textarea'),null);assert.match(unsafe.root.textContent,/設定を確認できません/);close(unsafe);
});

test('unknown archive after a fresh same-actor moderator response permits only explicit local closure and no archive write',async()=>{
  let reads=0;const writes=[],view=fixture({invoke:async(name,args)=>{if(name==='hub_detail')return page(0,{role:reads++?'moderator':'owner'});writes.push(args);throw Error('network');}});await open(view);draft(view,'アーカイブの変更理由');button(view.root,'アーカイブを確認').click();await button(view.root,'確認して変更を保存').onclick();assert.equal(button(view.root,'現在の設定を確認して操作を閉じる'),undefined);await button(view.root,'設定を再読み込み').onclick();assert.equal(button(view.root,'同じ変更の保存結果を確認').disabled,true);const local=button(view.root,'現在の設定を確認して操作を閉じる');assert.ok(local);local.click();assert.equal(writes.length,1);assert.equal(button(view.root,'アーカイブを確認'),undefined);assert.ok(button(view.root,'投稿間隔の変更を確認'));assert.match(view.root.textContent,/現在の設定は変更していません/);close(view);
});

test('actual app onChanged rereleases and remounts the policy controller without the old save clearing the shared saved receipt',async()=>{
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8'),fn=name=>{const start=source.indexOf(name),end=source.indexOf('\n}',start)+2;assert.ok(start>=0&&end>start);return source.slice(start,end);};
  const mount=source.split('\n').find(line=>line.trimStart().startsWith('policy=communityChannelPolicyControls('));assert.ok(mount);
  const dom=new JSDOM('<main></main><p id="status"></p>'),target=dom.window.document.querySelector('main'),notice=dom.window.document.querySelector('#status'),entry={name:'community',ids:[cid]},calls=[];let currentSeconds=5;
  const ctx=vm.createContext({videoCommentsController:null,attachDetailAiHandoff(){},document:dom.window.document,communityChannelPolicyControls,communityChannelPolicyController:null,detailTrail:[entry],currentView:'detail',detailRenderRevision:0,researchAccountGeneration:1,DETAIL_PARENT_VIEW:{community:'community'},readingDirectory:new Set(),DETAIL_RENDERERS:{},
    releaseResearchDetail(){},paintDetailHead(){},detailState:()=>notice,detailContent:()=>target,skeletonResult:()=>dom.window.document.createElement('div'),communityAppealReviewRequest:()=>null,communityReportReviewRequest:()=>null,communityMembershipReviewRequest:()=>null,communityGuideRequest:e=>({name:e.name,ids:e.ids}),appendResearchBacklinks(){},renderSidebarContext(){},friendlyError:String,isReadAccessDenied:()=>false,
    invoke:async(name,args)=>{calls.push({name,args});if(name==='hub_detail')return args.name==='community'?{community:{id:cid}}:page(0,{channels:[channel({slowmodeSeconds:currentSeconds})]});currentSeconds=args.options.slowmodeSeconds;return reply(args);}});
  vm.runInContext(fn('function releaseCommunityChannelPolicy(invalidate=false){'),ctx);vm.runInContext(fn('async function renderDetailEntry(entry) {'),ctx);
  ctx.DETAIL_RENDERERS.community=vm.runInContext(`(target,data,entry)=>{const community=data.community,revision=detailRenderRevision,generation=researchAccountGeneration;let policy;${mount.trim()}target.replaceChildren(policy.root);return policy;}`,ctx);
  await ctx.renderDetailEntry(entry);const old=ctx.communityChannelPolicyController;old.root.open=true;await old.root.ontoggle();draft({root:old.root,dom});button(old.root,'投稿間隔の変更を確認').click();const request=entry.channelPolicyState.channelPolicies[JSON.stringify([cid])].operation.requestId;await button(old.root,'確認して変更を保存').onclick();await tick();const current=ctx.communityChannelPolicyController;assert.notEqual(current,old);await current.ready;
  assert.equal(entry.channelPolicyState.channelPolicies[JSON.stringify([cid])].saved.requestId,request);assert.match(target.textContent,/変更は保存済み/);assert.equal(calls.filter(call=>call.name==='hub_client_action').length,1);assert.equal(button(target,'同じ変更の保存結果を確認'),undefined);ctx.releaseCommunityChannelPolicy();dom.window.close();
});

test('disposed view scope becomes stale during a pending save, unblocks its pinned retry on return without clearing new shared state',async()=>{
  const pending=deferred(),writes=[],state={other:'KEEP'};let revision=1;const first=fixture({isCurrent:()=>revision===1,invoke:async(name,args)=>{if(name==='hub_detail')return page();writes.push(args);return pending.promise;}},state);await open(first);draft(first);button(first.root,'投稿間隔の変更を確認').click();button(first.root,'確認して変更を保存').click();await tick();first.controller.dispose();revision=2;
  const returned=fixture({isCurrent:()=>revision===2},state);await returned.controller.ready;pending.resolve(reply(writes[0]));await tick();assert.equal(entry(state).sending,false);assert.equal(entry(state).operation.requestId,writes[0].requestId);assert.ok(button(returned.root,'同じ変更の保存結果を確認'));assert.equal(state.other,'KEEP');await button(returned.root,'同じ変更の保存結果を確認').onclick();assert.match(returned.root.textContent,/変更は保存済み/);assert.equal(returned.calls.filter(call=>call.name==='hub_client_action').length,1);close(returned);first.dom.window.close();
});
