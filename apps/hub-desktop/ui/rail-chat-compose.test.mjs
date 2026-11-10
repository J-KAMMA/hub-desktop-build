import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createRailChat} from './rail-chat.mjs';
import {pollGroup} from './rail-group-live.mjs';
import {createRailReader} from './rail-reader.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(r=>setTimeout(r,0));
const flush=async()=>{for(let i=0;i<12;i++)await tick();};
const origin='https://hub.example',scope={key:JSON.stringify([origin,'device-a']),generation:1};
const cmId=(viewer,community,req)=>'cm-'+createHash('sha256').update(JSON.stringify(['hub-community-message-v1',viewer,community,req])).digest('hex');
const dmId=(viewer,conv,req)=>'dm-'+createHash('sha256').update(JSON.stringify(['hub-dm-send-v1',viewer,conv,req])).digest('hex');

function build(t,{kind='public',canPost=true,invoke:custom,e2ee=false,uploadImages,processImage,subscribe}={}){
 const w=new JSDOM('<!doctype html><body></body>').window;t.after(()=>w.close());
 const document=w.document;const calls=[];const central=[];
 const community={viewerProfileId:'me',canPost,profiles:{me:{displayName:'私'}},messages:[]};
 const dmConv={id:'g1',participantIds:['me','u1','u2'],isE2ee:e2ee,verificationStatus:'unverified',fingerprint:'',unreadCountByProfileId:{me:0},lastMessageAt:'2026-11-05T09:00:00Z'};
 const dmMessages=[];
 const state={community,dmMessages};
 const invoke=async(name,args)=>{
  calls.push([name,structuredClone(args)]);
  if(custom){const r=await custom(name,args,state);if(r!==undefined)return r;}
  if(name==='hub_detail'&&(args.name==='community_posts'||args.name==='community_posts_kind'))return structuredClone(community);
  if(name==='hub_detail'&&args.name==='dm_snapshot')return {currentProfileId:'me',conversations:[dmConv],messages:structuredClone(dmMessages),profiles:[{id:'me',displayName:'私',handle:'me'},{id:'u1',displayName:'A',handle:'a'},{id:'u2',displayName:'B',handle:'b'}],messageCount:0};
  if(name==='hub_client'&&args.name==='conversations')return {currentProfileId:'me',profiles:[{id:'me',displayName:'私'}],messages:structuredClone(dmMessages)};
  if(name==='hub_client_action'&&args.action==='read_conversation')return {viewerId:'me',conversationId:args.target,unreadCount:0};
  if(name==='hub_client_action'&&args.action==='community_post'){
   const m={id:cmId('me','c1',args.requestId),communityId:'c1',authorProfileId:'me',body:args.text,kind:args.options.kind,replyToMessageId:null,images:(args.options.imageIds??[]).map(id=>({id})),createdAt:'2026-11-05T10:00:00Z'};
   community.messages.push(m);return {message:m};}
  if(name==='hub_client_action'&&args.action==='send_message'){
   const m={id:dmId('me',args.target,args.requestId),conversationId:args.target,senderProfileId:'me',encryptedPayload:'',previewText:args.text,encryptionVersion:'plaintext-v1',encryptionState:'sealed',createdAt:'2026-11-05T10:00:00Z',images:[]};
   dmMessages.push(m);return {viewerId:'me',message:m};}
  throw new Error('unexpected '+name);
 };
 const chat=createRailChat({document,invoke,deps:{relTime:()=>'今',hubAsset(){},icon:n=>`<svg data-icon="${n}"></svg>`,paintAvatar(){},friendlyError:e=>String(e?.message??e),
  openCentral:g=>central.push(g.id),getScope:async()=>scope,getDmScope:async()=>scope,uploadImages,uploadDmImages:async()=>[],processImage,subscribe:subscribe??(()=>({sync(){},stop(){}}))}});
 document.body.append(chat.element);
 const group=kind==='private'?{kind:'private',id:'g1',title:'私的',count:3}:{kind:'public',id:'c1',title:'公開',count:10};
 const type=text=>{chat.compose.input.value=text;chat.compose.input.dispatchEvent(new w.Event('input'));};
 const press=(init)=>{const e=new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...init});chat.compose.input.dispatchEvent(e);return e;};
 return {chat,document,w,calls,central,state,group,type,press,actions:()=>calls.filter(c=>c[0]==='hub_client_action'&&['community_post','send_message'].includes(c[1].action))};
}

test('public: Enter sends through community_post with the scoped options; the pending row becomes the real one',async t=>{
 const x=build(t);await x.chat.open(x.group);
 x.type('こんにちは');assert.equal(x.chat.compose.send.disabled,false);
 const e=x.press({shiftKey:true});assert.equal(e.defaultPrevented,false,'Shift+Enter keeps the newline');
 x.press({isComposing:true});assert.equal(x.actions().length,0,'IME confirm does not send');
 x.press();
 assert.equal(x.document.querySelectorAll('.rail-chat-msg.is-pending').length,1,'optimistic row appears at once');
 assert.equal(x.chat.compose.input.value,'');
 await flush();
 const [call]=x.actions();
 assert.equal(call[1].action,'community_post');assert.equal(call[1].target,'c1');assert.equal(call[1].text,'こんにちは');
 assert.deepEqual({...call[1].options},{kind:'chat',replyToMessageId:null,expectedDeviceId:'device-a',expectedOrigin:origin,expectedViewerId:'me'});
 assert.equal(x.document.querySelectorAll('.is-pending,.is-failed').length,0);
 assert.equal(x.document.querySelectorAll('.rail-chat-msg').length,1,'one real row, no duplicate');
});

test('public: a non-member sees a join button instead of the composer; it opens the group in the centre',async t=>{
 const x=build(t,{canPost:false});await x.chat.open(x.group);
 assert.equal(x.chat.compose.join.hidden,false);assert.equal(x.chat.compose.form.hidden,true);
 x.chat.compose.join.click();assert.deepEqual(x.central,['c1']);
 assert.equal(x.actions().length,0);
});

test('public: a definite rejection fails the row; retry reuses the same requestId and succeeds',async t=>{
 let n=0;const ids=[];
 const x=build(t,{invoke:async(name,args)=>{if(args.action==='community_post'){ids.push(args.requestId);if(++n===1)throw new Error('community_post_prewrite_rejected:429:slow');}}});
 await x.chat.open(x.group);x.type('再送');x.press();await flush();
 const failed=x.document.querySelector('.rail-chat-msg.is-failed');assert.ok(failed);
 assert.equal(x.chat.compose.input.value,'');
 [...failed.querySelectorAll('button')].find(b=>b.textContent==='再試行').click();await flush();
 assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
 assert.equal(x.document.querySelectorAll('.is-failed,.is-pending').length,0);
});

test('public: an unknown outcome checks for the message before re-sending and never double posts',async t=>{
 let n=0;
 const x=build(t,{invoke:async(name,args,state)=>{if(args.action==='community_post'){
   n++;if(n===1){const m={id:cmId('me','c1',args.requestId),communityId:'c1',authorProfileId:'me',body:args.text,kind:'chat',replyToMessageId:null,images:[],createdAt:'2026-11-05T10:00:00Z'};state.community.messages.push(m);throw new Error('network');}}}});
 await x.chat.open(x.group);x.type('届いたかも');x.press();await flush();
 const row=x.document.querySelector('.rail-chat-msg.is-failed');assert.match(row.textContent,/不明/);
 [...row.querySelectorAll('button')].find(b=>b.textContent==='確認して再送').click();await flush();
 assert.equal(n,1,'found the earlier write, did not send again');
 assert.equal(x.document.querySelectorAll('.is-failed,.is-pending').length,0);
 assert.equal(x.document.querySelectorAll('.rail-chat-msg').length,1);
});

test('public: images upload with the scoped invoke first, then ride along as imageIds',async t=>{
 const seen=[];
 const x=build(t,{invoke:async name=>{if(name==='hub_upload_image')return {image:{id:'x'}};},uploadImages:async(files,ctx)=>{await ctx.invoke('hub_upload_image',{n:files.length});return ['11111111-1111-4111-8111-111111111111'];}});
 await x.chat.open(x.group);
 const file=new x.w.File([new Uint8Array(10)],'a.png',{type:'image/png'});
 await x.chat.compose.addFiles([file]);assert.equal(x.chat.compose.send.disabled,false,'an image alone can be sent');
 x.chat.compose.submit();await flush();
 const up=x.calls.find(c=>c[0]==='hub_upload_image');assert.equal(up[1].expectedDeviceId,'device-a');assert.equal(up[1].expectedViewerId,'me');
 assert.deepEqual(x.actions()[0][1].options.imageIds,['11111111-1111-4111-8111-111111111111']);
 assert.equal(await x.chat.compose.addFiles([new x.w.File([new Uint8Array(1)],'a.gif',{type:'image/gif'})]),false,'only jpeg/png/webp');
});

test('drafts are kept per group in memory and come back on reopen',async t=>{
 const x=build(t);await x.chat.open(x.group);x.type('書きかけ');
 x.chat.close();await x.chat.open({kind:'public',id:'c2',title:'別',count:1});assert.equal(x.chat.compose.input.value,'');
 x.chat.close();await x.chat.open(x.group);assert.equal(x.chat.compose.input.value,'書きかけ');
 assert.ok(!/localStorage|sessionStorage/.test(readFileSync(new URL('./rail-chat.mjs',import.meta.url),'utf8')));
});

test('private: sends only through the DM path (dm_snapshot, then send_message) and never community_post',async t=>{
 const x=build(t,{kind:'private'});await x.chat.open(x.group);
 x.type('内緒');x.press();
 assert.equal(x.document.querySelectorAll('.rail-chat-msg.is-pending').length,1);
 assert.equal(x.chat.compose.input.maxLength,280);
 await flush();
 const acts=x.actions();assert.equal(acts.length,1);assert.equal(acts[0][1].action,'send_message');assert.equal(acts[0][1].target,'g1');assert.equal(acts[0][1].text,'内緒');
 assert.equal(acts[0][1].options.expectedViewerId,'me');
 assert.ok(x.calls.some(c=>c[0]==='hub_detail'&&c[1].name==='dm_snapshot'));
 assert.ok(!x.calls.some(c=>c[1]?.action==='community_post'));
 assert.equal(x.document.querySelectorAll('.is-pending,.is-failed').length,0);
 assert.equal(x.document.querySelectorAll('.rail-chat-msg').length,1);
});

test('private: an end-to-end encrypted group is never sent in the clear; the row points to the centre',async t=>{
 const x=build(t,{kind:'private',e2ee:true});await x.chat.open(x.group);
 x.type('秘密');x.press();await flush();
 assert.equal(x.actions().length,0,'nothing was sent');
 const row=x.document.querySelector('.rail-chat-msg.is-failed');assert.match(row.textContent,/暗号化/);
 [...row.querySelectorAll('button')].find(b=>b.textContent==='中央で開く').click();assert.deepEqual(x.central,['g1']);
});

test('private: a rejected send can be retried; an unknown one is rechecked instead of re-sent',async t=>{
 let n=0;
 const x=build(t,{kind:'private',invoke:async(name,args,state)=>{if(args.action==='send_message'){n++;if(n===1)throw new Error('dm_rejected:400');if(n===2){state.dmMessages.push({id:dmId('me',args.target,args.requestId),conversationId:args.target,senderProfileId:'me',encryptedPayload:'',previewText:args.text,encryptionVersion:'plaintext-v1',encryptionState:'sealed',createdAt:'2026-11-05T10:00:00Z',images:[]});throw new Error('network');}}}});
 await x.chat.open(x.group);
 x.type('一回目');x.press();await flush();
 let row=x.document.querySelector('.rail-chat-msg.is-failed');assert.ok(row);
 [...row.querySelectorAll('button')].find(b=>b.textContent==='再試行').click();await flush();
 row=x.document.querySelector('.rail-chat-msg.is-failed');assert.match(row.textContent,/不明/);
 assert.equal(x.chat.compose.send.disabled,true,'blocked while a result is unknown');
 [...row.querySelectorAll('button')].find(b=>b.textContent==='結果を確認').click();await flush();
 assert.equal(n,2,'recheck found it; no third send');
 assert.equal(x.document.querySelectorAll('.is-failed,.is-pending').length,0);
});

test('polling lifecycle: 10 s focused, 60 s unfocused, stops when hidden, resumes on sync, stops on stop()',async()=>{
 const timers=[];let id=0;
 const win={document:{visibilityState:'visible'},setTimeout:(fn,ms)=>{timers.push({id:++id,fn,ms});return id;},clearTimeout:i=>{const k=timers.findIndex(x=>x.id===i);if(k>=0)timers.splice(k,1);},addEventListener(){},removeEventListener(){}};
 let active=true,focused=true,refreshed=0;
 const live=pollGroup({win,refresh:async()=>{refreshed++;},isActive:()=>active,isFocused:()=>focused});
 assert.equal(timers.length,1);assert.equal(timers[0].ms,10_000);
 await timers[0].fn();timers.shift();assert.equal(refreshed,1);assert.equal(timers.at(-1).ms,10_000);
 focused=false;live.sync();assert.equal(timers.length,1);assert.equal(timers[0].ms,60_000,'backs off when unfocused');
 active=false;live.sync();assert.equal(timers.length,0,'hidden rail: nothing scheduled');
 active=true;focused=true;live.sync();assert.equal(timers.length,1);assert.equal(timers[0].ms,10_000);
 active=false;await timers[0].fn();timers.shift();assert.equal(refreshed,1,'a tick that finds the rail hidden does not fetch');assert.equal(timers.length,0);
 active=true;live.sync();live.stop();assert.equal(timers.length,0);live.sync();assert.equal(timers.length,0,'stopped stays stopped');
});

test('polling: chat starts it on open, stops on close, and pulls new lines in through subscribe',async t=>{
 let opts=null,stopped=0,syncs=0;
 const x=build(t,{subscribe:o=>{opts=o;return{sync(){syncs++;},stop(){stopped++;}};}});
 await x.chat.open(x.group);assert.ok(opts);
 assert.equal(opts.isActive(),true);
 x.state.community.messages.push({id:'n1',authorProfileId:'me',body:'外から',kind:'chat',createdAt:'2026-11-05T11:00:00Z'});
 await opts.refresh();assert.ok(x.document.querySelector('[data-message-id="n1"]'));
 x.chat.sync();assert.equal(syncs,1);
 x.chat.close();assert.equal(stopped,1);assert.equal(opts.isActive(),false);
});

test('thread reader: inline reply posts thread_reply with the thread settings and reloads',async()=>{
 const w=new JSDOM('<aside><button id="r">row</button></aside>').window;const d=w.document;const posted=[];let posts=[{body:'最初'}];
 const reader=createRailReader({document:d,read:async()=>({thread:{id:'t1',title:'T',status:'open',language:'ja'},posts:[...posts]}),open(){},friendlyError:String,
  replyThread:async a=>{posted.push(a);posts=[...posts,{body:a.text}];}});
 await reader.show('posts',d.querySelector('#r'),{title:'T',body:'',detail:{name:'thread',ids:['t1']}});
 const ta=d.querySelector('.rail-reply textarea');assert.ok(ta);
 ta.value='返信です';ta.dispatchEvent(new w.Event('input'));
 ta.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await flush();
 assert.equal(posted.length,1);assert.equal(posted[0].threadId,'t1');assert.equal(posted[0].text,'返信です');
 assert.match(d.querySelector('.rail-reader-body').textContent,/返信です/);
 assert.equal(d.querySelector('.rail-reply textarea').value,'');
 w.close();
 const w2=new JSDOM('<aside><button id="r">row</button></aside>').window;const d2=w2.document;
 const closed=createRailReader({document:d2,read:async()=>({thread:{id:'t1',status:'closed'}}),open(){},replyThread:async()=>{}});
 await closed.show('posts',d2.querySelector('#r'),{title:'T',detail:{name:'thread',ids:['t1']}});
 assert.equal(d2.querySelector('.rail-reply'),null,'no reply box on a closed thread');w2.close();
});

test('wiring: the rail passes the centre scope, upload and DM pieces; view changes sync the poll',()=>{
 const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 assert.match(app,/uploadImages: \(files, ctx\) => uploadChannelImages\(files, ctx\)/);
 assert.match(app,/uploadDmImages: \(items, ctx\) => uploadDmImages\(items, ctx\)/);
 assert.match(app,/placeRailAiWorkspace\(\);\s*railChat\.sync\(\);/);
 assert.match(app,/replyThread:\(\{threadId,text,thread\}\)=>[\s\S]*action:'thread_reply'/);
 assert.match(readFileSync(new URL('./rail-group-live.mjs',import.meta.url),'utf8'),/hub_realtime_open/);
 assert.match(app,/realtime: window\.__TAURI__\?\.event\?\.listen/);
});

// ---- 2026-11-06 グループの中の分け方（チャット / 共有 / メンバー、チャンネル＝投稿の種類） ----
test('public group in the rail: one slim bar of chips (#channels, 共有, メンバー) and ⋯; a private group has neither',async t=>{
 const x=build(t);await x.chat.open(x.group);await flush();
 assert.equal(x.document.querySelector('.rail-subtab'),null,'no tab strip');
 assert.deepEqual([...x.document.querySelectorAll('.rail-chat-nav .community-channel')].map(b=>b.textContent),['#雑談','#質問','#募集','共有','メンバー']);
 assert.equal(x.document.querySelector('.rail-chat-nav .rail-chat-more-toggle').textContent,'⋯');
 assert.equal(x.document.querySelector('.rail-chat-more-list .rail-chat-open').textContent,'中央で開く');
 assert.deepEqual([...x.document.querySelectorAll('.rail-chat-channels .community-channel:not(.is-extra)')].map(b=>b.textContent),['#雑談','#質問','#募集']);
 assert.equal(x.document.querySelector('.rail-chat-channels.is-horizontal, .community-channels.is-horizontal')!==null,true);
 const priv=build(t,{kind:'private'});await priv.chat.open(priv.group);await flush();
 assert.equal(priv.document.querySelector('.rail-chat-nav').hidden,true);
 assert.equal(priv.document.querySelectorAll('.rail-chat-channels .community-channel').length,0);
});

test('switching a channel reads that kind and posts with that kind, with its own draft',async t=>{
 const x=build(t);await x.chat.open(x.group);await flush();
 x.type('雑談の下書き');
 x.document.querySelector('.community-channel[data-kind="question"]').click();await flush();
 assert.equal(x.calls.filter(c=>c[0]==='hub_detail'&&c[1].name==='community_posts_kind').at(-1)[1].ids[1],'question');
 assert.equal(x.chat.compose.input.value,'','the draft belongs to the channel');
 x.type('質問です');x.press();await flush();
 const [call]=x.actions();
 assert.equal(call[1].options.kind,'question');
 x.document.querySelector('.community-channel[data-kind="chat"]').click();await flush();
 assert.equal(x.chat.compose.input.value,'雑談の下書き');
});

test('共有 and メンバー panes replace the chat; back to チャット restores the stream and the composer',async t=>{
 const x=build(t,{invoke:async(name,args)=>{
  if(name==='hub_detail'&&args.name==='community_members')return {members:[{id:'u1',displayName:'Aoi',handle:'aoi',role:'owner'},{id:'u2',displayName:'Kaze',handle:'kaze',role:'member'}]};
  if(name==='hub_detail'&&args.name==='community_content')return {items:[{contentType:args.ids[1],contentId:'a1',title:'共有の記事',summary:''}],nextCursor:null,canModerate:false};
  return undefined;}});
 await x.chat.open(x.group);await flush();
 const tab=label=>[...x.document.querySelectorAll('.rail-chat-nav .community-channel')].find(b=>b.textContent===label);
 tab('共有').click();await flush();
 assert.equal(x.document.querySelector('.rail-chat-pane').hidden,false);
 assert.equal(x.document.querySelector('.rail-chat-list').hidden,true);
 assert.equal(x.document.querySelector('.rail-chat-foot').hidden,true);
 assert.deepEqual([...x.document.querySelectorAll('.community-shared-kinds button')].map(b=>b.textContent),['記事','動画','音楽','共同ページ']);
 assert.match(x.document.querySelector('.community-content-title').textContent,/共有の記事/);
 tab('メンバー').click();await flush();
 assert.deepEqual([...x.document.querySelectorAll('.rail-chat-member strong')].map(n=>n.textContent),['Aoi','Kaze']);
 tab('#雑談').click();await flush();
 assert.equal(x.document.querySelector('.rail-chat-pane').hidden,true);
 assert.equal(x.document.querySelector('.rail-chat-list').hidden,false);
 assert.equal(x.document.querySelector('.rail-chat-foot').hidden,false);
});
