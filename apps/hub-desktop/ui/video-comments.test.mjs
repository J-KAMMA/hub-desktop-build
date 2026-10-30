import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createVideoComments} from './video-comments.mjs';
const videoId='video_1',viewerId='profile_1';
const root={id:'comment_1',videoId,body:'元のコメント',createdAt:'2026-10-06T00:00:00.000Z',updatedAt:'2026-10-06T00:00:00.000Z',likeCount:1,likedByViewer:false,author:{profileId:'author_1',handle:'author',displayName:'Author'}};
const child={...root,id:'comment_2',body:'返信',parentCommentId:root.id};
const snapshot=(comments=[root,child],viewer=viewerId)=>({viewerId:viewer,comments:structuredClone(comments)});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{data=snapshot(),state={},...options}={}){
  const dom=new JSDOM('<main></main>',{url:'http://localhost'}),document=dom.window.document,f={dom,document,state,data,calls:[]};
  f.respond=async(name,args)=>name==='hub_detail'?f.data:args.action==='video_comment_report'?{viewerId:f.data.viewerId,reported:true,commentId:args.options.commentId}:f.data;
  f.settings={videoId,state,invoke:async(name,args)=>{f.calls.push([name,args]);return f.respond(name,args);},...options};
  f.open=()=>{const controller=createVideoComments(document,f.settings);document.querySelector('main').append(controller.element);f.controller=controller;f.element=controller.element;return controller;};
  f.open();await f.controller.ready;t.after(()=>{f.controller.destroy();dom.window.close();});return f;
}
const button=(f,text)=>[...f.element.querySelectorAll('button')].find(item=>item.textContent===text);
const card=(f,commentId)=>f.element.querySelector(`[data-comment-id="${commentId}"]`);
const fill=(f,value)=>{const input=f.element.querySelector('textarea');input.value=value;input.dispatchEvent(new f.dom.window.Event('input'));};
const submit=f=>f.element.querySelector('form').onsubmit(new f.dom.window.Event('submit',{cancelable:true}));
function report(f,commentId=root.id){const select=card(f,commentId).querySelector('select');select.value='spam';select.onchange();return tick();}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('guest reads through exact native detail and has no mutation controls or requests',async t=>{
  const f=await fixture(t,{data:snapshot([root,child],null)});assert.deepEqual(f.calls,[['hub_detail',{name:'video_comments',ids:[videoId]}]]);assert.equal(f.element.querySelector('form').hidden,true);assert.equal(f.element.querySelector('select'),null);assert.match(f.element.textContent,/Hubへの接続が必要/);
  for(const control of [...f.element.querySelectorAll('article button')].filter(item=>!item.getAttribute('aria-label')))assert.equal(control.disabled,true);
  await card(f,root.id).querySelector('button[aria-pressed]').onclick();fill(f,'guest');await submit(f);assert.equal(f.calls.length,1);
});
test('only root comments can be replied to, and clearing the reply preserves the draft',async t=>{
  const f=await fixture(t);assert.equal([...card(f,child.id).querySelectorAll('button')].some(item=>item.textContent==='返信'),false);
  fill(f,'残す本文');button(f,'返信').click();assert.equal(f.state.parentCommentId,root.id);assert.match(f.element.textContent,/返信先: Author/);button(f,'返信先を解除').click();assert.equal(f.state.parentCommentId,undefined);assert.equal(f.state.body,'残す本文');assert.equal(f.element.querySelector('textarea').value,'残す本文');
  button(f,'返信').click();await submit(f);assert.deepEqual(f.calls[1],['hub_client_action',{action:'video_comment_create',target:videoId,options:{body:'残す本文',parentCommentId:root.id}}]);assert.equal(f.state.body,'');assert.equal(f.state.parentCommentId,undefined);
});
test('like, unlike, report and profile actions use closed payloads and stale rows cannot repeat actions',async t=>{
  const profiles=[],f=await fixture(t,{onProfile:handle=>profiles.push(handle)});const stale=card(f,root.id).querySelector('button[aria-pressed]');f.respond=async(name,args)=>{if(name==='hub_detail')return f.data;if(args.action==='video_comment_report')return {viewerId,reported:true,commentId:args.options.commentId};f.data=snapshot([{...root,likedByViewer:args.action==='video_comment_like',likeCount:args.action==='video_comment_like'?2:1},child]);return f.data;};
  await stale.onclick();await stale.onclick();await card(f,root.id).querySelector('button[aria-pressed]').onclick();await report(f);card(f,root.id).querySelector('button[aria-label]').click();assert.deepEqual(profiles,['author']);
  assert.deepEqual(f.calls.slice(1),[['hub_client_action',{action:'video_comment_like',target:videoId,options:{commentId:root.id}}],['hub_client_action',{action:'video_comment_unlike',target:videoId,options:{commentId:root.id}}],['hub_client_action',{action:'video_comment_report',target:videoId,options:{commentId:root.id,reason:'spam'}}]]);assert.match(f.element.textContent,/通報を受け付け/);
});
test('pending submit prevents duplicates and other writes, with trimmed UTF16 boundary validation',async t=>{
  const f=await fixture(t);for(const value of ['', ' \u3000 ', '🧪'.repeat(500)+'x']){fill(f,value);await submit(f);}assert.equal(f.calls.length,1);
  fill(f,'  '+'🧪'.repeat(500)+'  ');const wait=deferred();f.respond=()=>wait.promise;const pending=submit(f);await submit(f);await card(f,root.id).querySelector('button[aria-pressed]').onclick();await report(f);assert.equal(f.calls.length,2);assert.equal(f.calls[1][1].options.body.length,1000);assert.equal(f.element.querySelector('textarea').disabled,true);
  wait.resolve(snapshot());await pending;assert.equal(f.state.body,'');assert.equal(f.state.uncertain,false);assert.equal(f.element.querySelector('textarea').value,'');
});
test('orphan replies remain readable without offering a reply, and missing saved parents cannot be posted',async t=>{
  const orphan={...child,parentCommentId:'unavailable'},f=await fixture(t,{data:snapshot([orphan]),state:{body:'keep',parentCommentId:'unavailable'}});assert.match(f.element.textContent,/現在表示できないコメント/);assert.equal(button(f,'返信'),undefined);await submit(f);assert.equal(f.calls.length,1);button(f,'返信先を解除').click();assert.equal(f.state.body,'keep');await submit(f);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1][1].options,{body:'keep'});
});
test('renders bodies and author names as plaintext without executing markup',async t=>{
  const f=await fixture(t,{data:snapshot([{...root,body:'<img src=x onerror="run()"><script>run()</script>',author:{...root.author,displayName:'<svg onload="run()">'}}])});assert.equal(f.element.querySelector('img,script,svg'),null);assert.match(f.element.textContent,/<script>run\(\)<\/script>/);assert.match(f.element.textContent,/<svg/);
});
test('rejects malformed snapshots, mixed videos, IDs, duplicate or nested parents and unsafe numeric bounds',async t=>{
  const f=await fixture(t);const changes=[{id:root.id+'\n'},{id:'x'.repeat(129)},{videoId:'other'},{body:'x'.repeat(1001)},{body:' '},{createdAt:0},{updatedAt:'bad'},{likeCount:Number.MAX_SAFE_INTEGER+1},{likeCount:-1},{likedByViewer:1},{playbackSeconds:-1},{playbackSeconds:1.5},{playbackSeconds:604801},{parentCommentId:root.id},{author:{...root.author,profileId:'author\n'}},{storageKey:'secret'}];
  const invalids=[...changes.map(change=>snapshot([{...root,...change}])),snapshot([root,root]),snapshot([root,child,{...child,id:'third',parentCommentId:child.id}]),snapshot(Array.from({length:301},(_,i)=>({...root,id:`c${i}`}))),{...snapshot(),viewerId:'viewer\n'},{...snapshot(),extra:'secret'},{viewerId,comments:null},null];
  for(const value of invalids){f.data=value;await f.controller.reload();assert.match(f.element.textContent,/コメントを取得できません/);assert.match(f.element.textContent,/元のコメント/);assert.equal(f.element.querySelectorAll('article').length,2);}
  assert.equal(f.calls.filter(([name])=>name==='hub_client_action').length,0);
});
test('supports Hub opaque 160-character viewer/profile IDs and exact metadata bounds',async t=>{
  const viewer='p.'+'a'.repeat(158),author='p:'+'b'.repeat(158),f=await fixture(t,{data:snapshot([{...root,author:{...root.author,profileId:author},likeCount:Number.MAX_SAFE_INTEGER,playbackSeconds:604800}],viewer)});assert.equal(f.state.viewerId,viewer);fill(f,'ok');await submit(f);assert.equal(f.calls.length,2);
  assert.throws(()=>createVideoComments(f.document,{videoId:'video\n',invoke:()=>{}}),/invalid_video/);
});
test('viewer changes lock old drafts and actions, including when returning in a new controller',async t=>{
  const f=await fixture(t);fill(f,'old draft');f.data=snapshot([root],'other_profile');await f.controller.reload();assert.equal(f.element.querySelector('form').hidden,true);assert.equal(f.element.querySelectorAll('article').length,0);assert.match(f.element.textContent,/接続が変わりました/);await submit(f);assert.equal(f.calls.length,2);assert.equal(f.state.body,'old draft');assert.equal(f.state.viewerId,viewerId);
  f.controller.destroy();f.open();await f.controller.ready;assert.equal(f.element.querySelector('form').hidden,true);await submit(f);assert.equal(f.calls.length,3);assert.equal(f.state.body,'old draft');
});
test('mutation viewer mismatches never apply another profile response or permit subsequent writes',async t=>{
  for(const action of ['create','like','report']){
    const f=await fixture(t);fill(f,'keep');f.respond=async()=>action==='report'?{viewerId:'other',reported:true,commentId:root.id}:snapshot([root],'other');
    if(action==='create')await submit(f);else if(action==='like')await card(f,root.id).querySelector('button[aria-pressed]').onclick();else await report(f);
    assert.equal(f.element.querySelector('form').hidden,true);await submit(f);assert.equal(f.calls.length,2);assert.equal(f.state.body,'keep');assert.equal(f.state.viewerId,viewerId);
  }
});
test('unconfirmed report acknowledgements show failure and never claim acceptance',async t=>{
  const f=await fixture(t);for(const ack of [{viewerId,reported:false,commentId:root.id},{viewerId,reported:true,commentId:'other'},{viewerId,reported:true,commentId:root.id,extra:true}]){f.respond=async()=>ack;await report(f);assert.match(f.element.textContent,/結果を確認できません/);assert.doesNotMatch(f.element.textContent,/通報を受け付け/);}
});
test('late reads after view changes or destroy are ignored, and detached inputs cannot rewrite drafts',async t=>{
  for(const kind of ['stale','destroy']){
    let current=true;const f=await fixture(t,{isCurrent:()=>current}),wait=deferred();fill(f,'keep');const input=f.element.querySelector('textarea');f.respond=()=>wait.promise;const loading=f.controller.reload();if(kind==='destroy')f.controller.destroy();else current=false;wait.resolve(snapshot([{...root,body:'late'}]));await loading;input.value='stale input';input.dispatchEvent(new f.dom.window.Event('input'));assert.equal(f.state.body,'keep');assert.doesNotMatch(f.element.textContent,/late/);assert.equal(f.calls.length,2);
  }
});
test('account changes clear that account draft and ignore a late successful POST',async t=>{
  const f=await fixture(t),wait=deferred();fill(f,'private draft');const input=f.element.querySelector('textarea');f.respond=()=>wait.promise;const pending=submit(f);f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));wait.resolve(snapshot());await pending;input.value='old input';input.dispatchEvent(new f.dom.window.Event('input'));assert.equal(f.state.body,'');assert.equal(f.state.viewerId,undefined);assert.equal(f.state.uncertain,false);assert.equal(f.element.textContent,'');
});
test('leaving during a POST keeps the draft and uncertainty until fresh reload and explicit duplicate review',async t=>{
  for(const kind of ['destroy','detach','hidden','stale']){
    let current=true;const f=await fixture(t,{isCurrent:()=>current}),wait=deferred();fill(f,'unsure draft');button(f,'返信').click();f.respond=()=>wait.promise;const pending=submit(f);
    if(kind==='destroy')f.controller.destroy();else if(kind==='detach')f.element.remove();else if(kind==='hidden')f.document.querySelector('main').hidden=true;else current=false;
    wait.resolve(snapshot());await pending;assert.equal(f.state.body,'unsure draft');assert.equal(f.state.parentCommentId,root.id);assert.equal(f.state.uncertain,true);
    f.controller.destroy();current=true;f.document.querySelector('main').hidden=false;f.respond=async()=>f.data;f.open();await f.controller.ready;await submit(f);assert.equal(f.calls.length,3);assert.equal(f.element.querySelector('textarea').value,'unsure draft');assert.equal(button(f,'一覧を確認して再投稿を許可').hidden,false);
    button(f,'一覧を確認して再投稿を許可').click();await submit(f);assert.equal(f.calls.length,4);assert.equal(f.state.uncertain,false);assert.equal(f.state.body,'');
  }
});
test('failed or invalid POST retains draft and requires successful reload before explicit retry authorization',async t=>{
  const f=await fixture(t);fill(f,'keep');f.respond=async()=>{throw Error('offline');};await submit(f);assert.equal(f.state.uncertain,true);assert.equal(f.state.body,'keep');await submit(f);await f.controller.reload();assert.equal(button(f,'一覧を確認して再投稿を許可').hidden,true);button(f,'一覧を確認して再投稿を許可').click();await submit(f);assert.equal(f.calls.length,3);
  f.respond=async()=>snapshot([{...root,videoId:'other'}]);await f.controller.reload();assert.equal(button(f,'一覧を確認して再投稿を許可').hidden,true);f.respond=async()=>snapshot();await f.controller.reload();assert.equal(button(f,'一覧を確認して再投稿を許可').hidden,false);button(f,'一覧を確認して再投稿を許可').click();await submit(f);assert.equal(f.calls.length,6);assert.equal(f.state.body,'');
});
test('native invocation may reject with a string or nullish value without escaping error handling',async t=>{
  for(const value of ['native_failed',null,undefined]){
    const f=await fixture(t);fill(f,'keep');f.respond=async()=>{throw value;};await f.controller.reload();await card(f,root.id).querySelector('button[aria-pressed]').onclick();await submit(f);assert.equal(f.state.body,'keep');assert.equal(f.state.uncertain,true);assert.equal(f.element.querySelector('textarea').disabled,false);assert.match(f.element.textContent,/投稿結果が不明/);
  }
});

test('read-only mode shows earlier comments without any controls, and hides itself when there are none',async t=>{
  const f=await fixture(t,{readOnly:true});
  assert.equal(f.element.hidden,false);assert.equal(f.element.querySelector('h3').textContent,'以前のコメント');
  assert.equal(f.element.querySelector('form'),null);assert.equal(f.element.querySelector('select'),null);
  assert.deepEqual([...f.element.querySelectorAll('button')].map(b=>b.textContent),['Author','Author']);
  assert.ok(card(f,root.id)&&card(f,child.id));assert.deepEqual(f.calls.map(c=>c[0]),['hub_detail']);
  const empty=await fixture(t,{readOnly:true,data:snapshot([])});assert.equal(empty.element.hidden,true);
});
