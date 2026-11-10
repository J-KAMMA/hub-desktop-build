import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import * as tl from './rail-timeline.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const NOW=Date.parse('2026-11-06T00:00:00Z');
const iso=days=>new Date(NOW-days*86400000).toISOString();
const dom=t=>{const w=new JSDOM('<!doctype html><body></body>').window;t.after(()=>w.close());return w;};
const tick=()=>new Promise(r=>setTimeout(r,0));
const flush=async()=>{for(let i=0;i<6;i++)await tick();};

test('the switch table matches docs/hub-groups/DESIGN.md',()=>{
 assert.deepEqual(tl.TIMELINE_KINDS.map(([,l])=>l),['投稿','スレッド','グループ']);
 assert.deepEqual(tl.TIMELINE_SORTS.posts.map(([,l])=>l),['おすすめ','フォロー中','人気']);
 assert.deepEqual(tl.TIMELINE_SORTS.threads.map(([,l])=>l),['おすすめ','参加中・追跡中','人気']);
 assert.deepEqual(tl.TIMELINE_SORTS.groups.map(([,l])=>l),['おすすめ','参加中','人気']);
});

test('saved state is validated; unknown values fall back',()=>{
 assert.deepEqual(tl.normalizeTimelineState(null),{kind:'posts',sorts:{posts:'recommended',threads:'recommended',groups:'recommended'}});
 assert.deepEqual(tl.normalizeTimelineState({kind:'groups',sorts:{groups:'joined',posts:'evil',threads:'mine'}}),{kind:'groups',sorts:{posts:'recommended',threads:'mine',groups:'joined'}});
 assert.equal(tl.normalizeTimelineState({kind:'x'}).kind,'posts');
});

test('interest terms come only from followed-post tags and joined groups',()=>{
 const terms=tl.interestTerms({followingPosts:[{tags:['旅','#写真','a']},{tags:[{name:'Music'}]},{body:'ignored',url:'x'}],joinedGroups:[{name:'Hiking Club',category:'outdoor'}]});
 assert.deepEqual(terms.sort(),['hiking club','music','outdoor','写真','旅'].sort());
 assert.equal(tl.interestScore('Music night',terms),1);
});

test('followed tags (sidebar) also feed the interest terms',()=>{
 assert.deepEqual(tl.interestTerms({followedTags:['#旅','ab','x']}).sort(),['ab','旅']);
});

test('threads: recommended ranks by interest then recency; popular by replies per age; mine by authorship or tracking',()=>{
 const threads=[
  {id:'a',title:'料理の話',postCount:3,updatedAt:iso(0.1)},
  {id:'b',title:'旅の計画',postCount:5,updatedAt:iso(2)},
  {id:'c',title:'雑談',postCount:80,updatedAt:iso(9)},
  {id:'d',title:'旅の写真',postCount:40,updatedAt:iso(0.5),authorProfileId:'me'},
  {id:'e',title:'閉じた',postCount:99,updatedAt:iso(0.1),status:'closed',viewerTracking:true},
  {id:'f',title:'追跡中',postCount:2,updatedAt:iso(5),viewerTracking:true}];
 assert.deepEqual(tl.rankThreads(threads,'recommended',{terms:['旅'],now:NOW}).map(t=>t.id).slice(0,2),['d','b']);
 assert.deepEqual(tl.rankThreads(threads,'recommended',{terms:[],now:NOW}).map(t=>t.id),['a','d','b','f','c'],'no interests: recency; closed dropped');
 assert.equal(tl.rankThreads(threads,'popular',{now:NOW})[0].id,'d');
 assert.deepEqual(tl.rankThreads(threads,'mine',{viewerId:'me',now:NOW}).map(t=>t.id),['e','d','f']);
 assert.deepEqual(tl.rankThreads(threads,'mine',{viewerId:null,now:NOW}).map(t=>t.id),['e','f']);
});

const communities=[
 {id:'c1',name:'写真クラブ',category:'写真',visibility:'public',memberCount:50,description:'撮る'},
 {id:'c2',name:'料理',visibility:'public',memberCount:900},
 {id:'c3',name:'秘密',visibility:'private',memberCount:5000},
 {id:'c4',name:'参加済み',visibility:'public',memberCount:10,lastMessageAt:iso(1)},
 {id:'c5',name:'可視性なし',memberCount:7000}];
const conversations={currentProfileId:'me',profiles:[{id:'me',displayName:'私'},{id:'u1',displayName:'A'},{id:'u2',displayName:'B'},{id:'u3',displayName:'C'}],
 conversations:[{id:'dm1',participantIds:['me','u1'],lastMessageAt:iso(0.2),unreadCountByProfileId:{me:0}},
  {id:'g1',participantIds:['me','u1','u2','u3'],lastMessageAt:iso(0.1),unreadCountByProfileId:{me:3}}]};
const models=tl.groupModels({communities,memberships:[{communityId:'c4',status:'active'},{communityId:'c1',status:'left'}],conversations});

test('groups: private groups come only from 3+ person conversations and never reach おすすめ or 人気',()=>{
 const priv=models.filter(m=>m.kind==='private');
 assert.deepEqual(priv.map(m=>m.id),['g1']);
 assert.equal(priv[0].title,'A、B、C');assert.equal(priv[0].unread,3);
 for(const sort of ['recommended','popular']){
  const ranked=tl.rankGroups(models,sort,{terms:['写真']});
  assert.ok(ranked.every(m=>m.kind==='public'&&m.visibility==='public'&&!m.joined),sort);
  assert.ok(!ranked.some(m=>['c3','c5','g1','c4'].includes(m.id)),`${sort} excludes private, unknown-visibility and joined`);
 }
 assert.equal(tl.rankGroups(models,'recommended',{terms:['写真']})[0].id,'c1','interest wins');
 assert.equal(tl.rankGroups(models,'popular')[0].id,'c2','members stand in for activity');
 assert.deepEqual(tl.rankGroups(models,'joined').map(m=>m.id),['g1','c4'],'joined = public member + private, newest first');
 const heated=tl.groupModels({communities:[{id:'x',name:'x',visibility:'public',memberCount:1,recentMessageCount:99},{id:'y',name:'y',visibility:'public',memberCount:500}]});
 assert.equal(tl.rankGroups(heated,'popular')[0].id,'x','server activity count is preferred when present');
});

function build(t,{signedIn=true,feed=null,observe=null,calls=[],rank=null}={}){
 const w=dom(t),document=w.document;
 const store=new Map();
 const invoke=async(name,args)=>{calls.push([name,args]);
  if(name==='hub_feed'){
   if(feed)return feed(args);
   const n=args.offset??0;
   return {posts:Array.from({length:2},(_,i)=>({id:`${args.scope}-${n+i}`,body:`b${n+i}`,createdAt:iso(1),tags:['旅']})),hasMore:n<2,nextOffset:n+2,nextCursor:null};
  }
  if(name==='hub_resource'&&args.resource==='threads')return {threads:[{id:'t1',title:'旅の話',postCount:4,updatedAt:iso(1),boardKey:'b'},{id:'t2',title:'x',postCount:1,updatedAt:iso(3),authorProfileId:'me'}],hasMore:false};
  if(name==='hub_resource'&&args.resource==='communities')return {communities,memberships:[{communityId:'c4',status:'active'}]};
  if(name==='hub_client'&&args.name==='conversations')return conversations;
  if(name==='hub_client'&&/_rankings_/.test(args.name)&&rank)return rank(args);
  if(name==='hub_detail'&&args.name==='sidebar')return {followedTags:['旅'],channels:[]};
  throw new Error('unexpected '+name);};
 const opened=[],composed=[];
 const deps={relTime:()=>'1日前',hubAsset(){},icon:n=>`<svg data-icon="${n}"></svg>`,paintAvatar(){},friendlyError:e=>String(e?.message??e),
  storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},
  renderPost:(post,{onOpen})=>{const a=document.createElement('article');a.className='post';a.dataset.postId=post.id;a.onclick=onOpen;return a;},
  signedIn:()=>signedIn,connect:()=>opened.push(['connect']),viewerId:()=>'me',
  openPost:(post)=>opened.push(['post',post.id]),openThread:(x)=>opened.push(['thread',x.id]),openGroup:(g)=>opened.push(['group',g.kind,g.id]),compose:k=>composed.push(k),observe};
 const timeline=tl.createRailTimeline({document,invoke,deps,now:()=>NOW});
 document.body.append(timeline.element);
 return {w,document,timeline,calls,opened,composed,store};
}

test('posts: おすすめ / フォロー中 / 人気 map to hub_feed scopes; cards open in the rail',async t=>{
 const ctx=build(t);
 await ctx.timeline.load();
 assert.equal(ctx.calls[0][1].scope,'recommended');
 assert.equal(ctx.document.querySelectorAll('.rail-tl-list .post').length,2);
 ctx.document.querySelector('.rail-tl-list .post').click();
 assert.deepEqual(ctx.opened[0],['post','recommended-0']);
 for(const [sub,scope] of [['following','following'],['popular','popular']]){
  ctx.document.querySelector(`[data-rail-subtab="${sub}"]`).click();await flush();
  assert.equal(ctx.calls.filter(c=>c[0]==='hub_feed').at(-1)[1].scope,scope);
 }
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_social_stream'),'no main-window-only command');
 assert.equal(JSON.parse(ctx.store.get(tl.TIMELINE_KEY)).sorts.posts,'popular','the choice is remembered');
});

test('infinite scroll: the sentinel loads the next page and appends without redrawing earlier cards',async t=>{
 let fire=null;const observer={observe(){},disconnect(){}};
 const ctx=build(t,{observe:cb=>{fire=cb;return observer;}});
 await ctx.timeline.load();
 const first=ctx.document.querySelector('.rail-tl-list .post');
 assert.equal(ctx.document.querySelector('.rail-tl-more').hidden,true,'observer replaces the button');
 fire();await flush();
 assert.equal(ctx.document.querySelectorAll('.rail-tl-list .post').length,4);
 assert.equal(ctx.document.querySelector('.rail-tl-list .post'),first,'earlier card is the same node');
 assert.deepEqual(ctx.calls.filter(c=>c[0]==='hub_feed').map(c=>c[1].offset),[0,2]);
 fire();await flush();fire();await flush();
 assert.equal(ctx.calls.filter(c=>c[0]==='hub_feed').length,2,'stops when hasMore is false');
});

test('without IntersectionObserver the 続きを表示 button pages instead',async t=>{
 const ctx=build(t);
 await ctx.timeline.load();
 const more=ctx.document.querySelector('.rail-tl-more');assert.equal(more.hidden,false);
 more.click();await flush();
 assert.equal(ctx.document.querySelectorAll('.rail-tl-list .post').length,4);
});

test('pull to refresh: touch pull or a strong wheel at the top reloads; mid-scroll does not',async t=>{
 const ctx=build(t);
 await ctx.timeline.load();
 const reloads=()=>ctx.calls.filter(c=>c[0]==='hub_feed').length;
 const before=reloads();
 const {document,w}=ctx;
 const touch=(type,y)=>{const e=new w.Event(type,{bubbles:true});e.touches=[{clientY:y}];return e;};
 const el=ctx.timeline.element;
 el.dispatchEvent(touch('touchstart',10));el.dispatchEvent(touch('touchmove',60));el.dispatchEvent(new w.Event('touchend',{bubbles:true}));
 await flush();assert.equal(reloads(),before,'short pull ignored');
 el.dispatchEvent(touch('touchstart',10));el.dispatchEvent(touch('touchmove',130));el.dispatchEvent(new w.Event('touchend',{bubbles:true}));
 await flush();assert.equal(reloads(),before+1,'long pull refreshes');
 for(let i=0;i<3;i++)el.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-60,bubbles:true}));
 await flush();assert.equal(reloads(),before+2,'strong upward wheel at top refreshes');
 const scroller=document.createElement('div');scroller.className='rail-view';Object.defineProperty(scroller,'scrollTop',{value:200});
 scroller.append(el);document.body.append(scroller);
 for(let i=0;i<4;i++)el.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-80,bubbles:true}));
 await flush();assert.equal(reloads(),before+2,'no refresh when scrolled down');
});

test('signed out: threads and groups fall back to the public lists ordered on the device',async t=>{
 const ctx=build(t,{signedIn:false});
 ctx.document.querySelector('[data-rail-subtab="threads"]').click();await flush();
 assert.deepEqual(ctx.calls.filter(c=>c[0]==='hub_resource').map(c=>c[1].resource),['threads']);
 assert.equal(ctx.document.querySelectorAll('.rail-tl-list .thread-list-card').length,2);
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_client'),'no private reads when signed out');
 ctx.document.querySelector('[data-rail-subtab="groups"]').click();await flush();
 assert.ok(ctx.calls.some(c=>c[0]==='hub_resource'&&c[1].resource==='communities'));
 for(const sub of ['recommended','popular']){
  ctx.document.querySelector(`[data-rail-subtab="${sub}"]`).click();await flush();
  assert.equal(ctx.document.querySelectorAll('.rail-tl-list .rail-tl-group--private').length,0,`${sub}: no private group`);
 }
 ctx.document.querySelector('.rail-tl-list .post').click();
 assert.equal(ctx.opened.at(-1)[0],'group');
});

const T=(id,extra={})=>({id,boardKey:'b',title:'題'+id,postCount:3,updatedAt:iso(1),status:'open',...extra});
const G=(id,extra={})=>({id,slug:id,name:'群'+id,category:'写真',visibility:'public',imageUrl:null,joined:false,role:null,lastMessageId:null,lastMessageAt:iso(2),...extra});

test('signed in: threads use the server rankings (fixed hub_client names) and page by cursor',async t=>{
 const asked=[];
 const rank=args=>{asked.push(args);return args.cursor?{mode:'popular',threads:[T('t3')],nextCursor:null}:{mode:'popular',threads:[T('t1'),T('t2')],nextCursor:'12|t2'};};
 const ctx=build(t,{rank});
 ctx.document.querySelector('[data-rail-subtab="threads"]').click();await flush();
 assert.equal(asked[0].name,'thread_rankings_recommended');assert.equal(asked[0].cursor,undefined);
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_resource'&&c[1].resource==='threads'),'no client-side ranking source');
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_detail'),'no client-side interest terms');
 assert.equal(ctx.document.querySelectorAll('.rail-tl-list .thread-list-card').length,2);
 ctx.document.querySelector('.rail-tl-more').click();await flush();
 assert.equal(asked.at(-1).cursor,'12|t2','the server cursor is passed back untouched');
 assert.equal(ctx.document.querySelectorAll('.rail-tl-list .thread-list-card').length,3);
 ctx.document.querySelector('[data-rail-subtab="mine"]').click();await flush();
 ctx.document.querySelector('[data-rail-subtab="popular"]').click();await flush();
 assert.deepEqual(asked.filter(a=>!a.cursor).map(a=>a.name),['thread_rankings_recommended','thread_rankings_mine','thread_rankings_popular']);
});

test('signed in: groups use community rankings; 参加中 also lists private group chats',async t=>{
 const asked=[];
 const rank=args=>{asked.push(args.name);return args.name==='community_rankings_joined'
  ?{mode:'joined',groups:[G('c4',{joined:true,lastMessageAt:iso(5)}),G('s1',{joined:true,visibility:'private',lastMessageAt:iso(6)})],nextCursor:null}
  :{mode:'x',groups:[G('c1'),G('c2')],nextCursor:null};};
 const ctx=build(t,{rank});
 ctx.document.querySelector('[data-rail-subtab="groups"]').click();await flush();
 assert.equal(asked[0],'community_rankings_recommended');
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_resource'&&c[1].resource==='communities'));
 assert.equal(ctx.document.querySelectorAll('.rail-tl-list .post').length,2);
 ctx.document.querySelector('.rail-tl-list .post').click();
 assert.deepEqual(ctx.opened.at(-1),['group','public','c1']);
 ctx.document.querySelector('[data-rail-subtab="joined"]').click();await flush();
 const rows=[...ctx.document.querySelectorAll('.rail-tl-list .post')];
 assert.equal(rows.length,3,'two communities + the 3-person chat');
 assert.ok(rows.some(r=>r.classList.contains('rail-tl-group--private')),'private chat is merged in');
 assert.equal(ctx.document.querySelectorAll('.rail-tl-lock').length,2,'a private community and a private chat show the lock');
 ctx.document.querySelector('[data-rail-subtab="popular"]').click();await flush();
 assert.equal(asked.at(-1),'community_rankings_popular');
 assert.equal(ctx.calls.filter(c=>c[0]==='hub_client'&&c[1].name==='conversations').length,1,'conversations are read only for 参加中');
});

test('noSignals shows an icon with a few words, not an explanation',async t=>{
 const ctx=build(t,{rank:()=>({mode:'recommended',threads:[],groups:[],nextCursor:null,noSignals:true})});
 ctx.document.querySelector('[data-rail-subtab="threads"]').click();await flush();
 const box=ctx.document.querySelector('.rail-tl-list .rail-state--empty');
 assert.ok(box?.querySelector('.rail-state-icon svg'),'icon');
 assert.equal(box.querySelector('p'),null,'no paragraph');
 assert.ok(box.textContent.length<=16,box.textContent);
 ctx.document.querySelector('[data-rail-subtab="groups"]').click();await flush();
 assert.ok(ctx.document.querySelector('.rail-tl-list .rail-state-icon svg'));
});

test('a server failure is shown as an error, not hidden by the old client-side ranking',async t=>{
 const ctx=build(t,{rank:()=>{throw new Error('ハブが 503 を返しています');}});
 ctx.document.querySelector('[data-rail-subtab="threads"]').click();await flush();
 assert.match(ctx.document.querySelector('.rail-state--error').textContent,/503/);
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_resource'&&c[1].resource==='threads'));
});

test('signed out: following / mine ask to connect; no private reads',async t=>{
 const ctx=build(t,{signedIn:false,feed:async()=>({posts:[],hasMore:false,signedIn:false})});
 ctx.document.querySelector('[data-rail-subtab="following"]').click();
 await flush();
 assert.ok(ctx.document.querySelector('.rail-state--signedOut'),'following shows the connect prompt');
 ctx.document.querySelector('.rail-state--signedOut button').click();
 assert.deepEqual(ctx.opened.at(-1),['connect']);
 ctx.document.querySelector('[data-rail-subtab="threads"]').click();await flush();
 ctx.document.querySelector('[data-rail-subtab="mine"]').click();await flush();
 assert.ok(ctx.document.querySelector('.rail-state--signedOut'));
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_client'),'no private reads when signed out');
});

test('compose button: shown for posts and threads, hidden for groups, opens the composer',async t=>{
 const ctx=build(t);
 const btn=ctx.document.querySelector('.rail-tl-compose');
 assert.equal(btn.getAttribute('aria-label'),'投稿する');assert.equal(btn.hidden,false);
 btn.click();assert.deepEqual(ctx.composed,['posts']);
 ctx.document.querySelector('[data-rail-subtab="threads"]').click();await flush();
 assert.equal(btn.getAttribute('aria-label'),'スレッドを立てる');
 ctx.document.querySelector('[data-rail-subtab="groups"]').click();await flush();
 assert.equal(ctx.document.querySelector('.rail-tl-compose').hidden,true);
});

test('errors offer a retry; recommendations never read browsing history',async t=>{
 let fail=true;
 const ctx=build(t,{feed:async()=>{if(fail)throw new Error('boom');return {posts:[],hasMore:false};}});
 await ctx.timeline.load();
 assert.match(ctx.document.querySelector('.rail-state--error').textContent,/boom/);
 fail=false;ctx.document.querySelector('.rail-state--error button').click();await flush();
 assert.ok(ctx.document.querySelector('.rail-state--empty'));
 const src=readFileSync(new URL('./rail-timeline.mjs',import.meta.url),'utf8').split('\n').filter(l=>!l.trim().startsWith('//')).join('\n');
 assert.ok(!/referrer|visited|location\.|browsingHistory|hub_browser|history/i.test(src),'no browsing-history source');
});
