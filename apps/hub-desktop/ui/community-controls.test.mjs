import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {communityChannelControls,communityMemberControls,communityPollCard,communityComposerTools} from './community-controls.mjs';
const tick = () => new Promise(resolve=>setTimeout(resolve,0));
function fixture(){const dom=new JSDOM('');return {dom,doc:dom.window.document,select(root,label,value){const field=root.querySelector(`[aria-label="${label}"]`);field.value=value;field.dispatchEvent(new dom.window.Event('input'));return field},button(root,label){return [...root.querySelectorAll('button')].find(item=>item.textContent===label)}};}
const channels=[{id:'ch-1',name:'一般',description:''},{id:'ch-2',name:'質問',description:''}];
test('channel deletion requires confirmation and an exact receipt; the last channel is protected',async()=>{const f=fixture();let called=0;const root=communityChannelControls(f.doc,{communityId:'c-1',channels,invoke:async()=>{called++;return{deleted:true}},refresh:()=>{},confirm:()=>false});const select=root.querySelector('select');select.value='ch-1';select.dispatchEvent(new f.dom.window.Event('change'));f.button(root,'削除').click();await tick();assert.equal(called,0);const one=communityChannelControls(f.doc,{communityId:'c-1',channels:channels.slice(0,1),invoke:async()=>{},refresh:()=>{},confirm:()=>true});one.querySelector('select').value='ch-1';one.querySelector('select').dispatchEvent(new f.dom.window.Event('change'));assert.equal(f.button(one,'削除').disabled,true);f.dom.window.close()});
test('member search pages at 20 and manager controls respect self, owner, and moderator boundaries',()=>{const f=fixture();const members=Array.from({length:21},(_,i)=>({id:'m-'+i,displayName:'Member '+i,handle:'member'+i,role:i===0?'owner':i===1?'moderator':'member',status:'active'}));const root=communityMemberControls(f.doc,{communityId:'c-1',members,viewerId:'m-2',viewerRole:'moderator',canManage:true,invoke:async()=>{},refresh:()=>{}});assert.equal(root.querySelectorAll('article').length,20);assert.equal(root.querySelectorAll('article')[0].querySelector('details'),null);assert.equal(root.querySelectorAll('article')[1].querySelector('details'),null);assert.equal(root.querySelectorAll('article')[2].querySelector('details'),null);assert.equal(root.querySelectorAll('article')[3].querySelectorAll('button').length,2);f.button(root,'次の20人').click();assert.equal(root.querySelectorAll('article').length,1);f.select(root,'メンバーを検索','ＭＥＭＢＥＲ３');assert.equal(root.querySelectorAll('article').length,1);f.dom.window.close()});
const member = {id:'other',displayName:'Other',handle:'other',role:'member',status:'active'};
const memberOptions = {communityId:'c-1',members:[member],viewerId:'me',viewerRole:'owner',canManage:true,confirm:()=>true,refresh:()=>{}};
const memberReceipt = (payload, extra = {}) => ({member:{profileId:payload.options.profileId,role:'member',status:'muted',receipt:{auditId:payload.requestId,targetId:payload.options.profileId,action:payload.action.replace('community_', ''),confirmedAt:'2026-10-02T00:00:00Z',replayed:false},...extra}});

test('member mutations preserve drafts and operation IDs through redraws and suppress duplicate clicks',async()=>{
  const f=fixture(), state={}, calls=[];let release, refreshed=0;
  const options={...memberOptions,state,invoke:async(_,payload)=>{calls.push(payload);if(calls.length===1)await new Promise(resolve=>release=resolve);return{}},refresh:()=>{refreshed++}};
  let root=communityMemberControls(f.doc,options);
  f.select(root,'管理操作の理由（任意）','  Ａ理由  ');f.button(root,'ミュート').click();f.button(root,'ミュート').click();
  f.select(root,'メンバーを検索','other');assert.equal(f.button(root,'ミュート').disabled,true);f.button(root,'ミュート').click();assert.equal(calls.length,1);
  release();await tick();assert.match(root.textContent,/結果を確認できません/);
  root=communityMemberControls(f.doc,options);assert.equal(root.querySelector('[aria-label="管理操作の理由（任意）"]').value,'  Ａ理由  ');assert.equal(root.querySelector('[aria-label="メンバーを検索"]').value,'other');
  f.select(root,'管理操作の理由（任意）','A理由');f.button(root,'ミュート').click();await tick();
  assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].options.note,'A理由');
  f.select(root,'管理操作の理由（任意）','別の理由');f.button(root,'ミュート').click();await tick();assert.notEqual(calls[1].requestId,calls[2].requestId);
  f.select(root,'管理操作の理由（任意）','Ａ理由 ');f.button(root,'ミュート').click();await tick();assert.equal(calls[0].requestId,calls[3].requestId);
  f.button(root,'参加を禁止').click();await tick();assert.notEqual(calls[3].requestId,calls[4].requestId);assert.equal(refreshed,0);f.dom.window.close();
});

test('member search and page survive recreation and keep reasons across page changes',()=>{
  const f=fixture(),state={},options={...memberOptions,state,members:Array.from({length:21},(_,i)=>({...member,id:'m-'+i,displayName:'Member '+i,handle:'member'+i})),invoke:async()=>{}};
  let root=communityMemberControls(f.doc,options);f.select(root,'管理操作の理由（任意）','理由');f.button(root,'次の20人').click();
  root=communityMemberControls(f.doc,options);assert.equal(root.querySelector('h3').textContent,'Member 20');assert.equal(state.page,1);
  f.button(root,'前の20人').click();assert.equal(root.querySelector('[aria-label="管理操作の理由（任意）"]').value,'理由');
  f.select(root,'メンバーを検索','ＭＥＭＢＥＲ２０');root=communityMemberControls(f.doc,options);assert.equal(root.querySelectorAll('article').length,1);assert.equal(state.page,0);f.dom.window.close();
});

test('member confirmation names the target and normalized reason and cancellation sends nothing',async()=>{
  const f=fixture();let preview,calls=0;const root=communityMemberControls(f.doc,{...memberOptions,confirm:text=>{preview=text;return false},invoke:async()=>{calls++}});
  f.select(root,'管理操作の理由（任意）','  Ａ理由  ');f.button(root,'ミュート').click();await tick();assert.match(preview,/Other/);assert.match(preview,/@other/);assert.match(preview,/A理由/);assert.equal(calls,0);f.dom.window.close();
});

test('member mutations reject receipts for another request, target, action, or profile',async()=>{
  const f=fixture();let refreshed=0;
  for(const field of ['auditId','targetId','action','profileId']){
    const root=communityMemberControls(f.doc,{...memberOptions,invoke:async(_,payload)=>{const result=memberReceipt(payload);if(field==='profileId')result.member.profileId='wrong';else result.member.receipt[field]='wrong';return result},refresh:()=>{refreshed++}});
    f.button(root,'ミュート').click();await tick();assert.match(root.textContent,/結果を確認できません/);assert.equal(f.button(root,'ミュート').disabled,false);
  }
  assert.equal(refreshed,0);f.dom.window.close();
});

test('saved member changes reflect state and remain blocked after reload failure with a reload path',async()=>{
  const f=fixture(),state={};let calls=0,reloads=0;
  const options={...memberOptions,state,invoke:async(_,payload)=>{calls++;return memberReceipt(payload)},refresh:async()=>{reloads++;if(reloads===1)throw Error('offline')}};
  let root=communityMemberControls(f.doc,options);const stale=f.button(root,'ミュート');stale.click();await tick();
  assert.match(root.textContent,/ミュート中/);assert.match(root.textContent,/変更は保存済み/);assert.match(root.textContent,/offline/);assert.equal(f.button(root,'ミュート'),undefined);assert.equal(f.button(root,'ミュート解除'),undefined);
  await stale.onclick();assert.equal(calls,1);
  root=communityMemberControls(f.doc,options);assert.match(root.textContent,/ミュート中/);assert.match(root.textContent,/変更は保存済み/);
  f.button(root,'メンバー一覧を再読込').click();await tick();assert.equal(reloads,2);assert.equal(calls,1);assert.equal(f.button(root,'ミュート解除'),undefined);f.dom.window.close();
});

test('fresh member reload can reset only saved targets and retain another target draft',async()=>{
  const f=fixture(),state={},members=[member,{...member,id:'second',displayName:'Second',handle:'second'}];let latest;
  const options={...memberOptions,state,members,invoke:async(_,payload)=>memberReceipt(payload),refresh:()=>{
    for(const [id,target] of state.targets)if(target.saved)state.targets.delete(id);
    latest=communityMemberControls(f.doc,{...options,members:[{...member,status:'muted'},members[1]]});
  }};
  const root=communityMemberControls(f.doc,options);f.select(root.querySelectorAll('article')[1],'管理操作の理由（任意）','second draft');f.button(root,'ミュート').click();await tick();
  assert.ok(f.button(latest,'ミュート解除'));assert.equal(latest.querySelectorAll('article')[1].querySelector('input').value,'second draft');f.dom.window.close();
});

test('banned members expose no management controls even to owners',()=>{
  const f=fixture();for(const viewerRole of ['owner','moderator']){
    const root=communityMemberControls(f.doc,{...memberOptions,viewerRole,members:[{...member,status:'banned'}],invoke:async()=>{}});
    assert.match(root.textContent,/参加禁止中/);assert.equal(root.querySelector('details'),null);assert.equal(f.button(root,'ミュート解除'),undefined);
  }
  f.dom.window.close();
});

test('polls show read-only counts and disable expired or unprivileged votes',async()=>{const f=fixture();let calls=0;for(const [canVote,closesAt] of [[false,null],[true,'2020-01-01'],[true,'bad-date']]){const root=communityPollCard(f.doc,{communityId:'c-1',canVote,options:[{optionId:'o-1',label:'A',voteCount:2,voted:1,closesAt}],invoke:async()=>{calls++},refresh:()=>{}});assert.equal(root.querySelector('button').disabled,true);root.querySelector('button').click();assert.match(root.textContent,/2票/)}await tick();assert.equal(calls,0);f.dom.window.close()});
test('poll retry keeps its request ID and draft, then clears only after acknowledgement',async()=>{const f=fixture();const textarea=f.doc.createElement('textarea'),kind=f.doc.createElement('select');const calls=[];let ok=false;const root=communityComposerTools(f.doc,{communityId:'c-1',channelId:'ch-1',textarea,kind,hasImages:()=>false,invoke:async(_,p)=>{calls.push(p);if(!ok)throw Error('lost response');return{message:{id:'poll-1'}}},refresh:()=>{}});f.select(root,'アンケートの質問','Question');f.select(root,'選択肢（1行に1つ、2〜10件）','A\nB');const button=f.button(root,'アンケートを作成');button.click();await tick();assert.equal(root.querySelector('[aria-label="アンケートの質問"]').value,'Question');ok=true;button.click();await tick();assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(root.querySelector('[aria-label="アンケートの質問"]').value,'');f.dom.window.close()});
test('scheduling needs a preview and explicit final click, and retains draft on failure',async()=>{const f=fixture();const textarea=f.doc.createElement('textarea');textarea.value='Scheduled body';const kind=f.doc.createElement('select');kind.append(f.doc.createElement('option'));kind.firstChild.value='chat';const calls=[];let ok=false;const root=communityComposerTools(f.doc,{communityId:'c-1',channelId:'ch-1',textarea,kind,hasImages:()=>false,invoke:async(_,p)=>{calls.push(p);if(!ok)throw Error('failed');return{scheduled:true}},refresh:()=>{}});f.select(root,'公開日時',new Date(Date.now()+3600000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16));f.button(root,'予約を確認').click();assert.equal(calls.length,0);assert.match(root.textContent,/Scheduled body/);f.button(root,'この内容で予約する').click();await tick();assert.equal(textarea.value,'Scheduled body');ok=true;f.button(root,'この内容で予約する').click();await tick();assert.equal(calls[0].text,'Scheduled body');assert.equal(textarea.value,'');f.dom.window.close()});
