import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createCommunityPostComposer} from './community-post-composer.mjs';
import {communityMessageRequestIdentity} from '../../hub/lib/server/community-message-request.ts';

const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const source=await readFile(new URL('./app.js',import.meta.url),'utf8');
function region(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`actual app region missing: ${start}`);
  return source.slice(a,b);
}
// Execute the actual renderer, card and upload adapter, without app startup/IPC.
const makeRuntime=new Function('env',`
  const {document,createChannelComposer,researchEditorOptions,articleEditorScope,
    renderDetailEntry,friendlyError,detailSection,emptyState,communityComposerTools,
    communityPollCard,processComposerImage,URL,invoke,confirm,relTime,hubAsset,reportForm}=env;
  let researchAccountGeneration=1,detailRenderRevision=1,currentView='detail',detailTrail=[];
  ${region('const MESSAGE_KIND_LABELS =','function renderCommunityStream(')}
  ${region('function renderCommunityStream(','// --- 出品詳細')}
  ${region('async function uploadChannelImages(','async function uploadComposerImages(')}
  return {render:renderCommunityStream,activate(entry){currentView='detail';detailTrail=[entry];detailRenderRevision++;},
    leave(){currentView='feed';detailRenderRevision++;},account(){researchAccountGeneration++;detailRenderRevision++;}};
`);
const IMAGE='12345678-1234-4234-8234-123456789abc';
const scope=(device='device-A',generation=1)=>({key:JSON.stringify(['http://127.0.0.1:3020',device]),generation});
const defer=()=>{let resolve;const promise=new Promise(a=>{resolve=a;});return{promise,resolve};};
const message=(id='message-A',extra={})=>({id,communityId:'community-A',authorProfileId:'viewer-A',body:'existing message',kind:'chat',
  replyToMessageId:null,images:[],createdAt:'2026-10-07T00:00:00Z',...extra});
async function receipt(args){
  const identity=await communityMessageRequestIdentity(args.options.expectedViewerId,args.requestId,{communityId:args.target,
    body:args.text,kind:args.options.kind,replyToMessageId:args.options.replyToMessageId,imageIds:args.options.imageIds});
  return {message:message(identity.messageId,{body:args.text,kind:args.options.kind,replyToMessageId:args.options.replyToMessageId,
    images:(args.options.imageIds??[]).map(id=>({id}))})};
}

async function fixture(t,{messages=[message()],canPost=true,process,transport}={}){
  const dom=new JSDOM('<main></main>'),document=dom.window.document,target=document.querySelector('main');
  const calls=[],controllers=[],tools=[],polls=[],revoked=[],refreshes=[],scrolls=[],unsafe=[];
  let currentScope=scope(),lifecycle;
  dom.window.HTMLElement.prototype.scrollIntoView=function(){scrolls.push(this.dataset.messageId);};
  const node=(tag,text)=>{const el=document.createElement(tag);if(text)el.textContent=text;return el;};
  const item={blob:{arrayBuffer:async()=>Uint8Array.from([1,2,3]).buffer},thumbnailBlob:{arrayBuffer:async()=>Uint8Array.from([4,5]).buffer},
    width:2,height:3,thumbnailWidth:1,thumbnailHeight:1,previewUrl:'blob:synthetic-owned'};
  const safeInvoke=async(name,args)=>{calls.push({name,args});return transport?transport(name,args):name==='hub_upload_image'?{image:{id:IMAGE}}
    :args.action==='community_post'?receipt(args):{ok:true};};
  const runtime=makeRuntime({document,
    createChannelComposer:options=>{const c=createCommunityPostComposer(options);controllers.push(c);return c;},
    researchEditorOptions:()=>({invoke:safeInvoke}),articleEditorScope:()=>currentScope,
    renderDetailEntry:async entry=>{refreshes.push(entry);},friendlyError:()=> '操作を完了できませんでした。',
    detailSection:(title,children)=>{const section=node('section');section.append(node('h2',title),...children);return section;},
    emptyState:()=>node('p','empty'),
    communityComposerTools:(_document,options)=>{tools.push(options);const el=node('aside','existing poll tools');el.dataset.composerTools='true';return el;},
    communityPollCard:(_document,options)=>{polls.push(options);const el=node('button','投票');el.dataset.poll='true';
      el.onclick=async()=>{try{await options.invoke('hub_client_action',{action:'channel_poll_vote',target:options.communityId});}catch{}};return el;},
    processComposerImage:process?file=>process(file,item):async()=>item,
    URL:{revokeObjectURL:url=>revoked.push(url)},invoke:async(...args)=>{unsafe.push(args);throw Error('unguarded_invoke');},
    confirm:()=>true,relTime:()=> 'now',hubAsset:()=>{},reportForm:()=>node('div','report')});
  const entry={name:'community',ids:['community-A']};
  const data={messages,viewerProfileId:'viewer-A',canPost,canModerate:true,profiles:{'viewer-A':{displayName:'Author'}},
    pollOptions:[{id:'poll-A',messageId:messages[0]?.id}]};
  async function mount(selected=entry){runtime.activate(selected);lifecycle=runtime.render(target,data,selected);
    if(controllers.length)await controllers.at(-1).ready;return lifecycle;}
  await mount();
  t.after(()=>{lifecycle?.dispose();dom.window.close();});
  return {dom,document,target,entry,data,runtime,calls,controllers,tools,polls,revoked,refreshes,scrolls,unsafe,item,mount,
    get controller(){return controllers.at(-1);},get lifecycle(){return lifecycle;},
    setScope:value=>{currentScope=value;},
    input:value=>{const c=controllers.at(-1);c.textarea.value=value;c.textarea.dispatchEvent(new dom.window.Event('input'));},
    file:()=>new dom.window.File(['synthetic'],'selection.png',{type:'image/png'}),
    button:(label,host=target)=>[...host.querySelectorAll('button')].find(el=>el.textContent===label)};
}

test('actual post cards keep reply/edit/poll and composer tools; scoped upload reaches exact send ACK',async t=>{
  const r=await fixture(t),c=r.controller;
  assert.equal(r.tools.length,1);assert.equal(r.tools[0].textarea,c.textarea);assert.equal(r.tools[0].kind,c.kind);
  assert.equal(r.polls.length,1);assert.equal(r.polls[0].canVote,true);
  r.button('返信').click();assert.equal(r.entry.postDraft.reply.id,'message-A');
  r.button('編集').click();const edit=r.target.querySelector('.message-edit');assert.ok(edit);
  edit.querySelector('textarea').value='edited';await r.button('保存',edit).onclick();
  assert.equal(r.calls[0].args.action,'community_post_edit');assert.equal(r.refreshes.length,1);
  await r.target.querySelector('[data-poll]').onclick();assert.equal(r.calls.at(-1).args.action,'channel_poll_vote');assert.deepEqual(r.unsafe,[]);
  c.addFiles([r.file()]);assert.equal(r.tools[0].hasImages(),true);r.input(' image message ');
  assert.equal(await c.send(),true);
  const uploaded=r.calls.find(call=>call.name==='hub_upload_image');
  assert.deepEqual(uploaded.args.image,[1,2,3]);assert.deepEqual(uploaded.args.thumbnail,[4,5]);
  assert.equal(uploaded.args.expectedViewerId,'viewer-A');assert.equal(uploaded.args.expectedDeviceId,'device-A');
  const sent=r.calls.find(call=>call.args.action==='community_post');assert.equal(sent.args.text,'image message');
  assert.deepEqual(sent.args.options.imageIds,[IMAGE]);assert.equal(sent.args.options.replyToMessageId,'message-A');
  assert.deepEqual(r.revoked,['blob:synthetic-owned']);assert.equal(r.refreshes.length,2);
});

test('renderer disposal/back remount preserves same-entry category, reply and selected File without uploading',async t=>{
  const r=await fixture(t),file=r.file();r.input('kept draft');r.button('返信').click();r.controller.addFiles([file]);
  r.controller.kind.value='question';r.controller.kind.dispatchEvent(new r.dom.window.Event('change'));
  r.runtime.leave();r.lifecycle.dispose();r.target.replaceChildren();await r.mount();
  assert.equal(r.controller.textarea.value,'kept draft');assert.equal(r.controller.kind.value,'question');
  assert.equal(r.entry.postDraft.reply.id,'message-A');assert.equal(r.entry.postDraft.files[0],file);
  assert.equal(r.tools.at(-1).hasImages(),true);assert.deepEqual(r.calls,[]);
});

for(const phase of ['process','image-buffer','thumbnail-buffer','upload-ACK']){
  test(`account invalidation during actual ${phase} await suppresses late channel write/refresh and revokes preview`,async t=>{
    const gate=defer(),entered=defer();
    const pause=async result=>{entered.resolve();await gate.promise;return result;};
    const r=await fixture(t,{process:async(_file,item)=>{
      if(phase==='process')return pause(item);
      if(phase==='image-buffer')item.blob.arrayBuffer=()=>pause(Uint8Array.from([1]).buffer);
      if(phase==='thumbnail-buffer')item.thumbnailBlob.arrayBuffer=()=>pause(Uint8Array.from([2]).buffer);
      return item;
    },transport:async(name)=>name==='hub_upload_image'?pause({image:{id:IMAGE}}):assert.fail('late message mutation')});
    r.input('old actor');r.controller.addFiles([r.file()]);const pending=r.controller.send();await entered.promise;
    r.runtime.account();r.setScope(scope('device-B',2));r.lifecycle.invalidate();gate.resolve();
    assert.equal(await pending,false);assert.equal(r.calls.filter(call=>call.name==='hub_client_action').length,0);
    assert.equal(r.calls.filter(call=>call.name==='hub_upload_image').length,phase==='upload-ACK'?1:0);
    assert.deepEqual(r.entry.postDraft,{});assert.deepEqual(r.refreshes,[]);assert.deepEqual(r.revoked,['blob:synthetic-owned']);
  });
}

test('account invalidation blocks already-rendered edit/poll handlers and late send ACK refresh',async t=>{
  const entered=defer(),ack=defer();let payload;
  const r=await fixture(t,{transport:async(_name,args)=>{payload=args;entered.resolve();return ack.promise;}});
  r.button('編集').click();const save=r.button('保存',r.target.querySelector('.message-edit'));
  const poll=r.target.querySelector('[data-poll]');r.input('before logout');const pending=r.controller.send();await entered.promise;
  r.runtime.account();r.lifecycle.invalidate();await save.onclick();await poll.onclick();
  ack.resolve(await receipt(payload));assert.equal(await pending,false);
  assert.equal(r.calls.length,1);assert.deepEqual(r.unsafe,[]);assert.deepEqual(r.refreshes,[]);
});

test('notification locator focuses the exact dataset message, including CSS punctuation, without writing',async t=>{
  const selected='message["#target"]',r=await fixture(t,{messages:[message('other'),message(selected)]});
  r.lifecycle.dispose();r.entry.targetSelection={messageId:selected,applied:false};await r.mount();await Promise.resolve();
  assert.equal(r.document.activeElement.dataset.messageId,selected);assert.deepEqual(r.scrolls,[selected]);
  assert.equal(r.target.querySelectorAll('[data-notification-target]').length,1);assert.deepEqual(r.calls,[]);
});

test('missing/deleted notification targets expose unavailable status; stale queued focus never reaches new entry',async t=>{
  const r=await fixture(t,{messages:[message('deleted',{deletedAt:'2026-10-07T00:00:00Z'})]});
  for(const id of ['missing','deleted']){
    r.lifecycle.dispose();r.entry.targetSelection={messageId:id,applied:false};await r.mount();
    assert.match(r.target.querySelector('[role=status]').textContent,/通知の投稿は表示できません/);
    assert.equal(r.entry.targetSelection.applied,false);assert.deepEqual(r.scrolls,[]);
  }
  r.lifecycle.dispose();r.data.messages=[message('late')];r.entry.targetSelection={messageId:'late',applied:false};
  r.runtime.activate(r.entry);const lifecycle=r.runtime.render(r.target,r.data,r.entry);
  r.runtime.leave();lifecycle.dispose();await Promise.resolve();assert.deepEqual(r.scrolls,[]);assert.deepEqual(r.calls,[]);
});

test('read-only community keeps actual messages/poll and omits private composer/tools',async t=>{
  const r=await fixture(t,{canPost:false});assert.equal(r.controllers.length,0);assert.equal(r.tools.length,0);
  assert.equal(r.target.querySelectorAll('.community-post').length,1);assert.equal(r.polls[0].canVote,false);
  assert.equal(r.target.querySelector('form'),null);assert.match(r.target.textContent,/投稿権限が必要/);assert.deepEqual(r.calls,[]);
});

const pinned=(id,extra={})=>message(id,{pinnedAt:'2026-10-07T01:00:00Z',pinnedByProfileId:'mod-A',...extra});
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

test('the stream has no channel UI at all: no channel list, switcher, settings or channel text',async t=>{
  const r=await fixture(t);
  assert.doesNotMatch(r.target.textContent,/チャンネル/);
  assert.equal(r.target.querySelector('[data-channel-id],.channel-list,.channel-switch'),null);
  assert.deepEqual(r.calls.filter(call=>JSON.stringify(call).includes('channel')),[]);
});

test('posts show tag chips and a chip asks the loader for that kind only',async t=>{
  const kinds=[];const r=await fixture(t);
  r.lifecycle.dispose();r.target.replaceChildren();
  r.runtime.activate(r.entry);const life=r.runtime.render(r.target,r.data,r.entry,{onKind:kind=>kinds.push(kind)});t.after(()=>life.dispose());
  const chips=[...r.target.querySelectorAll('.community-kind-chips .chip')];
  assert.deepEqual(chips.map(chip=>chip.textContent),['すべて','雑談','共同ページ','質問','募集']);
  assert.equal(chips[0].getAttribute('aria-pressed'),'true');
  chips[3].click();chips[0].click();assert.deepEqual(kinds,['question']);
});

test('pinned posts carry the 固定 marker and the more button asks for the next cursor',async t=>{
  let more=0;const r=await fixture(t,{messages:[pinned('p1'),message('m2')]});
  r.lifecycle.dispose();r.target.replaceChildren();r.data.nextCursor='2026-10-07T00:00:00.000Z|m2';
  r.runtime.activate(r.entry);const life=r.runtime.render(r.target,r.data,r.entry,{onMore:()=>{more++;}});t.after(()=>life.dispose());
  const cards=[...r.target.querySelectorAll('.community-post')];
  assert.equal(cards[0].querySelector('.pin-marker').textContent,'固定');
  assert.equal(cards[1].querySelector('.pin-marker'),null);
  r.target.querySelector('.community-more').click();assert.equal(more,1);
});

test('pin and unpin are offered to moderators only and send the fixed verbs without any channel',async t=>{
  const r=await fixture(t,{messages:[message('a',{authorProfileId:'other'}),pinned('b',{authorProfileId:'other'})]});
  r.button('固定する').click();await settle();
  r.button('固定を解除').click();await settle();
  const sent=r.calls.map(call=>call.args);
  assert.deepEqual(sent.map(args=>args.action),['community_post_pin','community_post_unpin']);
  assert.deepEqual(sent.map(args=>args.options),[{messageId:'a'},{messageId:'b'}]);
  assert.equal(sent[0].target,'community-A');
  r.lifecycle.dispose();r.target.replaceChildren();r.data.canModerate=false;await r.mount();
  assert.equal(r.button('固定する'),undefined);assert.equal(r.button('固定を解除'),undefined);
});

test('a locked post shows a lock note and no body or actions',async t=>{
  const r=await fixture(t,{messages:[message('lock',{locked:true,gated:true,body:''})]});
  assert.match(r.target.textContent,/鍵付きの投稿です/);
  assert.equal(r.button('返信'),undefined);
});

test('reactions go to the posts verb with only the message and emoji',async t=>{
  const r=await fixture(t,{messages:[message('x',{authorProfileId:'other'})]});
  [...r.target.querySelectorAll('button.chip')].find(el=>el.textContent==='❤️').click();await settle();
  assert.deepEqual(r.calls.at(-1).args,{action:'community_post_reaction',target:'community-A',options:{messageId:'x',emoji:'❤️'}});
});
