import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createCommunityPostComposer} from './community-post-composer.mjs';
import {createPostRow} from './post-row.mjs';
import {orderCommunityMessages,normalizeCommunityOrder,COMMUNITY_ORDERS,TOP_PERIODS,normalizeTopPeriod} from './community-order.mjs';
import {applyThreadLinks} from './thread-lines.mjs';
import {createCommunityRow,rowFromPost,rowFromMessage,messageThreads} from './community-row.mjs';
import {buildReplyTree,renderReplyTree} from './reply-tree.mjs';
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
  const {document,orderCommunityMessages,normalizeCommunityOrder,COMMUNITY_ORDERS,TOP_PERIODS,normalizeTopPeriod,createChannelComposer,researchEditorOptions,articleEditorScope,
    renderDetailEntry,friendlyError,detailSection,emptyState,communityComposerTools,
    communityPollCard,processComposerImage,URL,invoke,confirm,relTime,hubAsset,reportForm,createPostRow,icon,paintAvatar,applyThreadLinks,loadSafetyControls,openListPicker,
    createCommunityRow,rowFromPost,rowFromMessage,messageThreads,buildReplyTree,renderReplyTree}=env;
  let researchAccountGeneration=1,detailRenderRevision=1,currentView='detail',detailTrail=[];
  ${region('const MESSAGE_KIND_LABELS =','function renderCommunityStream(')}
  ${region('function renderCommunityStream(','// --- 出品詳細')}
  ${region('async function uploadChannelImages(','async function uploadComposerImages(')}
  let factory=null;const unifiedComposerFor=spec=>factory(spec);
  return {setUnifiedFactory(f){factory=f;},render:renderCommunityStream,activate(entry){currentView='detail';detailTrail=[entry];detailRenderRevision++;},
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
  const runtime=makeRuntime({document,orderCommunityMessages,normalizeCommunityOrder,COMMUNITY_ORDERS,TOP_PERIODS,normalizeTopPeriod,createCommunityRow,rowFromPost,rowFromMessage,messageThreads,buildReplyTree,renderReplyTree,
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
    confirm:()=>true,relTime:()=> 'now',hubAsset:()=>{},reportForm:()=>node('div','report'),createPostRow,icon:name=>`<svg data-i="${name}"></svg>`,paintAvatar:()=>{},applyThreadLinks,loadSafetyControls:async()=>new Map(),openListPicker:()=>{}});
  const entry={name:'community',ids:['community-A']};
  // 流れ（chat）の統一した欄の代わり。欄そのものを確かめる検査は setUnifiedFactory で本物に差し替える。
  runtime.setUnifiedFactory(()=>({root:Object.assign(document.createElement('form'),{className:'uc-stub'}),body:document.createElement('textarea'),focus(){}}));
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
    button:(label,host=target)=>[...host.querySelectorAll('button')].find(el=>el.textContent===label||el.getAttribute('aria-label')===label)};
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
  assert.deepEqual(chips.map(chip=>chip.textContent),['すべて','雑談','質問','募集']);
  assert.equal(chips[0].getAttribute('aria-pressed'),'true');
  chips[2].click();chips[0].click();assert.deepEqual(kinds,['question']);
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
  r.button('いいね').click();await settle();
  assert.deepEqual(r.calls.at(-1).args,{action:'community_post_reaction',target:'community-A',options:{messageId:'x',emoji:'❤️'}});
});

test('community posts are post rows (not cards): avatar, name, handle, time, action row and the … menu per ownership',async t=>{
  const r=await fixture(t,{messages:[message('mine'),message('theirs',{authorProfileId:'other',replyToMessageId:'mine'})]});
  r.lifecycle.dispose();r.target.replaceChildren();r.data.profiles.other={displayName:'Other',handle:'other'};await r.mount();
  const [mine,theirs]=[...r.target.querySelectorAll('.community-post')];
  for(const row of [mine,theirs]){assert.ok(row.classList.contains('post'));assert.equal(row.classList.contains('card'),false);assert.ok(row.querySelector('.post-avatar'));}
  assert.match(theirs.querySelector('.post-head').textContent,/Other@othernow/);
  assert.deepEqual([...theirs.querySelectorAll('.post-action')].map(b=>b.getAttribute('aria-label')),['いいね','返信','共有（リンクをコピー）']);
  assert.deepEqual([...mine.querySelectorAll('.post-more-menu button')].map(b=>b.textContent).slice(0,3),['編集','削除','固定する']);
  assert.deepEqual([...theirs.querySelectorAll('.post-more-menu button')].map(b=>b.textContent).slice(0,5),['固定する','リストに追加','ミュート','ブロック','報告']);
  assert.ok(theirs.querySelector('.post-reply-to'));
  assert.ok(theirs.classList.contains('has-thread-prev')&&mine.classList.contains('has-thread-next'));
});

test('a channel fixes the post kind: no kind chips, the composer select is hidden and set to the channel',async t=>{
  const r=await fixture(t);
  r.lifecycle.dispose();r.target.replaceChildren();
  r.runtime.activate(r.entry);const life=r.runtime.render(r.target,r.data,r.entry,{kind:'question',chat:true});t.after(()=>life.dispose());
  assert.equal(r.target.querySelector('.community-kind-chips'),null);
  const select=r.controllers.at(-1).kind;
  assert.equal(select.hidden,true);assert.equal(select.value,'question');
});

test('chat order: pinned first, then newest first (新着) or by weight (人気); older posts load from the bottom',async t=>{
  let more=0;
  const r=await fixture(t,{messages:[message('new',{createdAt:'2026-10-09T00:00:00Z'}),message('old',{createdAt:'2026-10-07T00:00:00Z'}),pinned('pin')]});
  r.lifecycle.dispose();r.target.replaceChildren();r.data.nextCursor='x|old';
  r.runtime.activate(r.entry);const life=r.runtime.render(r.target,r.data,r.entry,{kind:'chat',chat:true,onMore:()=>{more++;}});t.after(()=>life.dispose());
  const scroll=r.target.querySelector('.community-chat-scroll');
  assert.ok(scroll);
  assert.equal(scroll.lastElementChild.textContent,'古い投稿を読み込む');
  assert.deepEqual([...scroll.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId),['pin','new','old']);
  scroll.lastElementChild.click();assert.equal(more,1);
});

test('the action row reads like, reply, share (same order as a post); a reader who cannot post still gets share',async t=>{
  const r=await fixture(t,{messages:[message('a',{authorProfileId:'other'})]});
  const labels=()=>[...r.target.querySelectorAll('.community-post .post-action')].map(b=>b.getAttribute('aria-label'));
  assert.deepEqual(labels(),['いいね','返信','共有（リンクをコピー）']);
  r.lifecycle.dispose();r.target.replaceChildren();r.data.canPost=false;r.data.viewerProfileId=null;
  r.runtime.activate(r.entry);const life=r.runtime.render(r.target,r.data,r.entry,{});t.after(()=>life.dispose());
  assert.deepEqual(labels(),['共有（リンクをコピー）']);
});

test('人気 orders the stream by weight and combines with the kind filter',async t=>{
  const now=new Date().toISOString();
  const r=await fixture(t,{messages:[message('calm',{createdAt:now}),message('hot',{createdAt:now,engagement:{replyCount:3}}),message('q',{createdAt:now,kind:'question',engagement:{replyCount:9}})]});
  r.lifecycle.dispose();r.target.replaceChildren();
  r.runtime.activate(r.entry);
  const ids=()=>[...r.target.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId);
  let life=r.runtime.render(r.target,r.data,r.entry,{kind:'chat',chat:true,order:'popular'});
  assert.deepEqual(ids(),['q','hot','calm']);
  life.dispose();r.target.replaceChildren();r.entry.stream={kind:'question'};
  life=r.runtime.render(r.target,r.data,r.entry,{kind:'chat',chat:true,order:'popular'});t.after(()=>life.dispose());
  assert.deepEqual(ids(),['q']);
});

test('posts_place items join the same ordering and chip filter, de-duplicated by id',async t=>{
  const now=Date.now(),at=m=>new Date(now-m*60000).toISOString();
  const r=await fixture(t,{messages:[message('a',{createdAt:at(10)}),message('dup',{createdAt:at(30)})]});
  r.lifecycle.dispose();r.target.replaceChildren();r.runtime.activate(r.entry);
  const placeItems=[{id:'p1',createdAt:at(5),kind:'chat',replyCount:1},{id:'dup',createdAt:at(1)},{id:'p2',createdAt:at(20),type:'question',likeCount:9}];
  const placeCard=item=>{const el=node('article',item.id);return el;};
  function node(tag,text){const el=r.target.ownerDocument.createElement(tag);el.textContent=text;return el;}
  const ids=()=>[...r.target.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId);
  let life=r.runtime.render(r.target,r.data,r.entry,{kind:'chat',chat:true,order:'latest',placeItems,placeCard});
  assert.deepEqual(ids(),['p1','a','p2','dup']);
  life.dispose();r.target.replaceChildren();
  life=r.runtime.render(r.target,r.data,r.entry,{kind:'chat',chat:true,order:'popular',placeItems,placeCard});
  assert.deepEqual(ids().slice(0,2),['p2','p1']);
  life.dispose();r.target.replaceChildren();r.entry.stream={kind:'question'};
  life=r.runtime.render(r.target,r.data,r.entry,{kind:'chat',chat:true,order:'latest',placeItems,placeCard});t.after(()=>life.dispose());
  assert.deepEqual(ids(),['p2']);
});

test('the open community stream (chat) uses the unified inline composer; its type choice decides the channel place and a post reloads the stream', async t=>{
  const {createUnifiedComposer}=await import('./unified-composer.mjs');
  const r=await fixture(t,{canPost:true});
  r.lifecycle.dispose();r.target.replaceChildren();r.controllers.length=0;
  r.runtime.setUnifiedFactory(spec=>createUnifiedComposer(r.document,{icon:name=>`<svg data-i="${name}"></svg>`,place:spec.place,placeLabel:spec.label,variant:spec.variant,placeholder:spec.placeholder,placeChoices:spec.placeChoices,
    invoke:async(name,args)=>{r.calls.push({name,args});return{post:{id:'u1',status:'published'}};},onPosted:spec.onPosted,randomId:(()=>{let n=0;return()=>`rid${++n}`;})(),
    prepareImage:async()=>{},uploadImage:async()=>'x'}));
  let reloads=0;
  r.runtime.activate(r.entry);
  const life=r.runtime.render(r.target,r.data,r.entry,{chat:true,reload:async()=>{reloads++;}});t.after(()=>life.dispose());
  assert.equal(r.controllers.length,0,'the old channel composer is not built');
  assert.equal(r.target.querySelector('[data-composer-tools]'),null);
  const root=r.target.querySelector('form.uc');assert.ok(root);
  assert.equal(root.dataset.variant,'inline');
  assert.equal(r.target.firstElementChild,root,'the composer is the first thing in the stream, like the timeline');
  assert.ok(root.compareDocumentPosition(r.target.querySelector('.community-rows'))&r.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.notEqual(r.document.activeElement,root.querySelector('textarea'),'opening the stream does not expand the composer');
  assert.equal(root.querySelector('.uc-place-pick').textContent,'雑談');
  const roles=[...root.querySelectorAll('.uc-place-item')].map(n=>n.dataset.place);
  assert.deepEqual(roles,['community-A:chat','community-A:question','community-A:party'].map(x=>`channel:${x}`));
  root.querySelector('.uc-place-pick').click();root.querySelectorAll('.uc-place-item')[2].click();
  const body=root.querySelector('textarea');body.value='今夜 集まれる人';body.dispatchEvent(new r.dom.window.Event('input'));
  root.dispatchEvent(new r.dom.window.Event('submit',{cancelable:true}));
  await new Promise(done=>setTimeout(done,0));
  const sent=r.calls.find(call=>call.args?.action==='create_post_v2');
  assert.equal(sent.args.options.place,'channel:community-A:party');assert.equal(sent.args.options.body,'今夜 集まれる人');
  assert.equal(reloads,1);
  // Painting again keeps the same form and what was typed (the held composer survives a re-render).
  body.value='書きかけ';body.dispatchEvent(new r.dom.window.Event('input'));
  life.dispose();r.target.replaceChildren();
  const again=r.runtime.render(r.target,r.data,r.entry,{chat:true,reload:async()=>{reloads++;}});t.after(()=>again.dispose());
  assert.equal(r.target.querySelector('form.uc'),root);assert.equal(root.querySelector('textarea').value,'書きかけ');
  // A reader who cannot post gets no composer.
  again.dispose();r.target.replaceChildren();r.data.canPost=false;r.entry.communityUnified=undefined;
  const readonly=r.runtime.render(r.target,r.data,r.entry,{chat:true});t.after(()=>readonly.dispose());
  assert.equal(r.target.querySelector('form.uc'),null);
});

test('the sort lives in the stream toolbar only: 新着 / 人気 beside the type chips, and a press asks the loader without reading again',async t=>{
  const orders=[];const r=await fixture(t);
  r.lifecycle.dispose();r.target.replaceChildren();r.runtime.activate(r.entry);
  let life=r.runtime.render(r.target,r.data,r.entry,{chat:true,order:'latest',onOrder:o=>orders.push(o)});
  const bar=r.target.querySelector('.community-toolbar');assert.ok(bar);
  assert.ok(bar.querySelector('.community-kind-chips'));
  const items=[...bar.querySelectorAll('.community-order .community-order-item')];
  assert.deepEqual(items.map(b=>[b.textContent,b.getAttribute('aria-pressed')]),[['新着','true'],['人気','false'],['トップ','false']]);
  items[0].click();items[1].click();assert.deepEqual(orders,['popular']);
  assert.equal(bar.querySelector('.community-period'),null,'no period picker unless トップ');
  assert.equal(r.target.querySelectorAll('.community-order').length,1);
  life.dispose();r.target.replaceChildren();
  life=r.runtime.render(r.target,r.data,r.entry,{chat:true,order:'popular'});t.after(()=>life.dispose());
  assert.equal(r.target.querySelector('.community-order [data-order="popular"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(r.calls,[]);
});

test('stream rows are dense: one row per thread with type chip, author, time and the reply count; replies are counted, not listed',async t=>{
  const opened=[],liked=[];
  const r=await fixture(t,{messages:[message('root',{authorProfileId:'other',body:'一行目\n二行目',kind:'question',reactions:[{emoji:'❤️',count:4}]}),
    message('re1',{replyToMessageId:'root'}),message('re2',{replyToMessageId:'re1'})]});
  r.lifecycle.dispose();r.target.replaceChildren();r.data.profiles.other={displayName:'Other',handle:'other',communityRole:'moderator'};r.runtime.activate(r.entry);
  const post={id:'u1',kind:'post',title:'題',body:'本文',communityKind:'party',createdAt:new Date().toISOString(),author:{displayName:'Poster',handle:'poster',communityRole:'owner'},counts:{replies:7,likes:2,saves:0},
    attachments:[{type:'image',refId:'img-1'}],places:['channel:community-A:party'],viewer:{liked:false}};
  const life=r.runtime.render(r.target,r.data,r.entry,{chat:true,placeItems:[post,{...post,id:'u2',replyToPostId:'u1'}],openPost:p=>opened.push(p.id),likePost:async(p,on)=>{liked.push([p.id,on]);return{likes:3,liked:true};}});t.after(()=>life.dispose());
  const rows=[...r.target.querySelectorAll('.community-rows > .community-row')];
  assert.deepEqual(rows.map(row=>row.dataset.postId),['u1','root'],'replies (old and new) are not rows');
  assert.equal(r.target.querySelector('.community-rows .post-avatar'),null,'dense rows carry no avatar');
  const [unified,legacy]=rows;
  assert.equal(unified.querySelector('.community-row-title').textContent,'題');
  assert.equal(unified.querySelector('.community-row-kind').textContent,'募集');
  assert.equal(unified.querySelector('.community-row-author .role-mark-owner')?.getAttribute('aria-label'),'運営');
  assert.equal(unified.querySelector('.community-row-replies').getAttribute('aria-label'),'返信 7件');
  assert.ok(unified.querySelector('.community-row-thumb img'));
  assert.equal(legacy.querySelector('.community-row-title').textContent,'一行目');
  assert.ok(legacy.querySelector('.community-row-title').classList.contains('is-plain'));
  assert.equal(legacy.querySelector('.community-row-kind').textContent,'質問');
  assert.ok(legacy.querySelector('.role-mark-moderator'));
  assert.equal(legacy.querySelector('.community-row-replies b').textContent,'2');
  assert.equal(legacy.querySelector('.community-row-like b').textContent,'4');
  unified.click();assert.deepEqual(opened,['u1']);
  unified.querySelector('.community-row-like').click();await settle();
  assert.deepEqual(liked,[['u1',true]]);assert.deepEqual(opened,['u1'],'liking does not open the post');
  assert.equal(unified.querySelector('.community-row-like').getAttribute('aria-pressed'),'true');
  legacy.querySelector('.community-row-like').click();await settle();
  assert.deepEqual(r.calls.at(-1).args,{action:'community_post_reaction',target:'community-A',options:{messageId:'root',emoji:'❤️'}});
});

test('an old-style message opens in place as a thread: the message, its replies nested under guide lines, and a reply box aimed at it',async t=>{
  const threads=[];
  const r=await fixture(t,{messages:[message('root',{createdAt:'2026-10-07T00:00:00Z'}),message('a',{replyToMessageId:'root',createdAt:'2026-10-07T00:01:00Z'}),
    message('b',{replyToMessageId:'a',createdAt:'2026-10-07T00:02:00Z'}),message('other',{createdAt:'2026-10-07T00:03:00Z'})]});
  r.lifecycle.dispose();r.target.replaceChildren();r.controllers.length=0;r.runtime.activate(r.entry);
  let life=r.runtime.render(r.target,r.data,r.entry,{chat:true,onThread:id=>threads.push(id)});
  r.target.querySelector('.community-row[data-post-id="root"]').click();assert.deepEqual(threads,['root']);
  life.dispose();r.target.replaceChildren();r.entry.stream.thread='root';
  life=r.runtime.render(r.target,r.data,r.entry,{chat:true,onThread:id=>threads.push(id)});t.after(()=>life.dispose());
  await r.controllers.at(-1).ready;
  assert.equal(r.target.querySelector('.community-toolbar'),null);assert.equal(r.target.querySelector('.community-row'),null);
  assert.equal(r.target.querySelector('.community-thread-root').dataset.messageId,'root');
  const nodes=[...r.target.querySelectorAll('.reply-tree .reply-node')];
  assert.deepEqual(nodes.map(n=>[n.dataset.replyId,n.dataset.depth]),[['a','1'],['b','2']]);
  assert.equal(r.target.querySelector('[data-message-id="other"]'),null,'other threads stay out');
  assert.equal(r.entry.postDraft.reply.id,'root');
  r.target.querySelector('.reply-guide').click();
  assert.equal(r.target.querySelector('.reply-node[data-reply-id="a"]').dataset.collapsed,'true');
  assert.ok(r.entry.stream.collapsed.has('a'));
  r.target.querySelector('.community-thread-back').click();assert.deepEqual(threads,['root',null]);
});

test('a notification that points at a reply opens that reply\'s thread before focusing it',async t=>{
  const r=await fixture(t,{messages:[message('root'),message('deep',{replyToMessageId:'root'})]});
  r.lifecycle.dispose();r.target.replaceChildren();r.runtime.activate(r.entry);r.entry.targetSelection={messageId:'deep',applied:false};
  const life=r.runtime.render(r.target,r.data,r.entry,{chat:true});t.after(()=>life.dispose());await Promise.resolve();
  assert.equal(r.entry.stream.thread,'root');
  assert.equal(r.document.activeElement.dataset.messageId,'deep');assert.equal(r.entry.targetSelection.applied,true);
});

test('トップ shows a period picker (今日 / 今週 / 今月 / すべて, default 今週) beside the sort; changing it asks the loader for the period',async t=>{
  const periods=[];const r=await fixture(t);
  r.lifecycle.dispose();r.target.replaceChildren();r.runtime.activate(r.entry);
  const life=r.runtime.render(r.target,r.data,r.entry,{chat:true,order:'top',onPeriod:p=>periods.push(p)});t.after(()=>life.dispose());
  assert.equal(r.target.querySelector('.community-order [data-order="top"]').getAttribute('aria-pressed'),'true');
  const select=r.target.querySelector('.community-toolbar .community-period');assert.ok(select);
  assert.deepEqual([...select.options].map(o=>o.textContent),['今日','今週','今月','すべて']);
  assert.equal(select.value,'week');
  select.value='month';select.dispatchEvent(new r.target.ownerDocument.defaultView.Event('change'));
  assert.deepEqual(periods,['month']);
  assert.deepEqual(r.calls,[]);
});
