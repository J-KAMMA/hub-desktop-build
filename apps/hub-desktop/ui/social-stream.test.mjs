import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createSocialStream,parseSocialStream,renderSocialItem} from './social-stream.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const time=n=>`2026-10-08T00:00:${String(n).padStart(2,'0')}.000Z`,origin='https://hub.synthetic.invalid';
const source=(changes={})=>({origin,viewerId:'viewer',generation:{},filter:'all',scope:'latest',...changes});
const post=(id='post-1',n=30,changes={})=>({kind:'post',id,createdAt:time(n),origin,payload:{id,body:'合成の投稿',createdAt:time(n),authorName:'Synthetic',authorHandle:'synthetic',authorProfileId:'author',avatarUrl:null,replyCount:0,repostCount:0,likeCount:0,likedByViewer:false,bookmarkedByViewer:false,viewerRepostId:null,images:[],tags:[],referenced:null,identityMode:'account',replyToPostId:null,...changes}});
const thread=(id='thread-1',n=20)=>({kind:'thread',id,createdAt:time(n),origin,payload:{id,title:'合成スレッド',boardKey:'board',postCount:2,threadType:'discussion',status:'open',updatedAt:time(n)}});
const community=(id='community-post-1',n=10)=>({kind:'community_post',id,createdAt:time(n),origin,payload:{id,communityId:'community',communityName:'合成コミュニティ',channelId:'channel',channelName:'合成チャンネル',body:'<img src=x>本文は文字列',createdAt:time(n),authorName:'Synthetic',authorHandle:null,replyCount:0,likeCount:0,kind:'chat'}});
const page=(items=[post(),thread(),community()],changes={})=>({version:1,filter:'all',scope:'latest',viewerId:'viewer',signedIn:true,items,hasMore:false,nextCursor:null,failures:[],...changes});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(t){const dom=new JSDOM('<main></main>'),document=dom.window.document,f={dom,document,context:source(),active:true,calls:[],opened:[],reply:page(),statuses:[]};
 f.controller=createSocialStream({document,invoke:async(name,args)=>{f.calls.push({name,args});if(f.reply instanceof Error)throw f.reply;return typeof f.reply==='function'?f.reply(name,args):f.reply;},getContext:()=>f.context,isCurrent:()=>f.active,renderPost:value=>{const node=document.createElement('article');node.className='post';node.textContent=value.body;return node;},onOpenThread:value=>f.opened.push(['thread',value.id]),onOpenCommunityPost:value=>f.opened.push(['community',value.id]),onStatus:value=>f.statuses.push(value)});document.querySelector('main').append(f.controller.element);t.after(()=>{f.controller.destroy();dom.window.close();});return f;}
test('strict closed stream carries legacy widths without truncating and clones data',()=>{
 const raw=page([post('long',30,{body:'x'.repeat(40000)})]),parsed=parseSocialStream(raw,source());assert.equal(parsed.items[0].payload.body.length,40000);parsed.items[0].payload.body='copy';assert.equal(raw.items[0].payload.body.length,40000);
 for(const broken of [page([post('too-long',30,{body:'x'.repeat(40001)})]),page([thread('x')],{filter:'post'}),page([post()],{version:2}),page([post()],{signedIn:false}),page([post()],{owner:'private'}),page([post()],{failures:['post','post']})])assert.throws(()=>parseSocialStream(broken,source()));
});
test('nested private metadata, malformed Unicode, unsafe URLs and anonymous attribution fail closed',()=>{
 for(const patch of [{privateKey:'synthetic-marker'},{body:'\ud800'},{avatarUrl:'javascript:alert(1)'},{identityMode:'anonymous'},{identityMode:'guest',authorHandle:null,avatarUrl:null},{images:[{id:'image',url:'https://image.invalid/a',width:10,height:10,altText:'',storageKey:'private'}]}])assert.throws(()=>parseSocialStream(page([post('p',30,patch)]),source()));
 const anonymous=post('anon',30,{identityMode:'anonymous',authorProfileId:null,authorHandle:null,avatarUrl:null});assert.equal(parseSocialStream(page([anonymous]),source()).items[0].payload.identityMode,'anonymous');
 const cm=community();cm.payload.body='x'.repeat(4001);assert.throws(()=>parseSocialStream(page([cm]),source()));
});
test('counts, cursor bytes, source identity, ordering, duplicates and escaped response budget are bounded',()=>{
 for(const raw of [page([post()],{nextCursor:'x',hasMore:false}),page([post()],{hasMore:true,nextCursor:'x'.repeat(4097)}),page([post(),post()]),page([community(),post()]),page(Array.from({length:21},(_,i)=>post('p'+i))),page([post('p',30,{likeCount:Number.MAX_SAFE_INTEGER+1})])])assert.throws(()=>parseSocialStream(raw,source()));
 assert.throws(()=>parseSocialStream(page([],{viewerId:'other'}),source()),/scope_changed/);const foreign=post();foreign.origin='https://foreign.invalid';assert.throws(()=>parseSocialStream(page([foreign]),source()),/scope_changed/);
 const huge=Array.from({length:20},(_,i)=>post('p'+i,30,{body:'\u0001'.repeat(40000),referenced:{label:'引用',title:'資料',body:'\u0001'.repeat(40000),href:'/posts/ref'}})).sort((a,b)=>a.id>b.id?-1:1);assert.throws(()=>parseSocialStream(page(huge),source()));
});
test('constructor is read free; fixed read renders all three kinds in server order with literal community body and guarded CTAs',async t=>{
 const f=fixture(t);assert.equal(f.calls.length,0);assert.equal(await f.controller.load(),true);assert.deepEqual(f.calls,[{name:'hub_social_stream',args:{filter:'all',scope:'latest',limit:20,cursor:null}}]);assert.deepEqual([...f.controller.element.querySelectorAll('[data-social-kind]')].map(node=>node.dataset.socialKind),['post','thread','community_post']);assert.equal(f.controller.element.querySelector('img'),null);assert.match(f.controller.element.textContent,/<img src=x>/);
 for(const node of f.controller.element.querySelectorAll('[data-social-kind] button'))node.click();assert.deepEqual(f.opened,[['thread','thread-1'],['community','community-post-1']]);/* 接続中のHubのものにはアドレスを出さない（2026-10-12）。 */assert.doesNotMatch(f.controller.element.textContent,/https:\/\/hub.synthetic.invalid/);
});
test('append deduplicates by kind/id/origin while cursor is opaque and unchanged cursor is rejected',async t=>{
 const f=fixture(t);f.reply=page([post('shared'),thread('shared'),community('shared')],{hasMore:true,nextCursor:'opaque-next'});await f.controller.load();f.reply=page([post('shared'),community('new',5)]);await f.controller.more();assert.equal(f.controller.status().items.length,4);assert.equal(f.calls.at(-1).args.cursor,'opaque-next');
 f.reply=page([post()],{hasMore:true,nextCursor:'same'});await f.controller.load();f.reply=page([community('older',1)],{hasMore:true,nextCursor:'same'});assert.equal(await f.controller.more(),false);assert.equal(f.controller.status().items[0].id,'post-1');
});
test('same condition source failures retain only failed lane cards and recover on explicit read without automatic calls',async t=>{
 const f=fixture(t);await f.controller.load();f.reply=page([thread('fresh-thread',40),community('fresh-community',35)],{failures:['post'],hasMore:true,nextCursor:'partial'});await f.controller.load();assert.deepEqual(f.controller.status().items.map(item=>item.id),['fresh-thread','fresh-community','post-1']);assert.match(f.controller.element.textContent,/前回表示を残しています/);assert.equal(f.calls.length,2);f.reply=page([post('fresh-post',45)]);await f.controller.load();assert.deepEqual(f.controller.status().items.map(item=>item.id),['fresh-post']);assert.equal(f.calls.length,3);
});
test('a first partial page is usable but changed filter or actor failure cannot mix an old snapshot',async t=>{
 const f=fixture(t);f.reply=page([thread()],{failures:['post'],hasMore:true,nextCursor:'partial'});await f.controller.load();assert.equal(f.controller.status().items.length,1);f.context={...f.context,filter:'community',generation:{}};f.reply=Error('synthetic failure');await f.controller.load();assert.equal(f.controller.status().items.length,0);assert.equal(f.controller.element.querySelectorAll('[data-social-id]').length,0);
});
test('viewer mismatches and authenticated access denial clear retained private display',async t=>{
 const f=fixture(t);await f.controller.load();f.reply=page([],{viewerId:'other'});await f.controller.load();assert.equal(f.controller.status().items.length,0);f.reply=page();await f.controller.load();f.reply=Error('account_changed');await f.controller.load();assert.equal(f.controller.status().items.length,0);assert.equal(f.controller.element.querySelectorAll('[data-social-id]').length,0);f.reply=page();await f.controller.load();f.reply=Promise.reject('social_stream_scope_changed');await f.controller.load();assert.equal(f.controller.status().items.length,0);
 for(const code of ['social_stream_auth_unavailable','social_stream_access_denied','auth_unavailable','access_denied']){f.reply=page();await f.controller.load();f.reply=Error(code);await f.controller.load();assert.equal(f.controller.status().items.length,0);}
});
test('an older condition response cannot overwrite a newer read and pending presses dispatch once',async t=>{
 const f=fixture(t),old=deferred();f.reply=old.promise;const first=f.controller.load();await f.controller.load();assert.equal(f.calls.length,1);f.context={...f.context,scope:'following',generation:{}};f.reply=page([post('new')],{scope:'following'});await f.controller.load();old.resolve(page([post('old')]));await first;assert.equal(f.controller.status().items[0].id,'new');assert.equal(f.calls.length,2);
});
test('view departure generation, disposal and detached card callbacks never commit late results or navigation',async t=>{
 const f=fixture(t);await f.controller.load();const oldButton=f.controller.element.querySelector('[data-social-kind="thread"] button');f.context={...f.context,generation:{}};oldButton.click();assert.equal(f.opened.length,0);const pending=deferred();f.reply=pending.promise;const read=f.controller.load();f.active=false;f.controller.invalidate();f.active=true;pending.resolve(page([post('late')]));await read;assert.equal(f.controller.status().items.length,0);
 f.reply=page();await f.controller.load();const pending2=deferred();f.reply=pending2.promise;const read2=f.controller.load();f.controller.destroy();pending2.resolve(page());await read2;assert.equal(f.controller.element.querySelectorAll('[data-social-id]').length,0);
});
test('guest source requires null viewer and signed out coherence; private fields never render after a rejected page',async t=>{
 const f=fixture(t);f.context=source({viewerId:null});f.reply=page([post('public')],{viewerId:null,signedIn:false});await f.controller.load();assert.equal(f.controller.status().items.length,1);const malformed=post('bad',40);malformed.payload.providerSecret='synthetic-private-marker';f.reply=page([malformed],{viewerId:null,signedIn:false});assert.equal(await f.controller.load(),false);assert.doesNotMatch(f.controller.element.textContent,/synthetic-private-marker/);assert.equal(f.controller.status().items[0].id,'public');
});

test('server tie order and identifier width match the shared version1 contract',()=>{
 const rows=[post('z',30),post('a',30),thread('t',30),community('c',30)];assert.equal(parseSocialStream(page(rows),source()).items.length,4);assert.throws(()=>parseSocialStream(page([thread('t',30),post('z',30)]),source()));
 const legacy=post('p'.repeat(200),30);assert.equal(parseSocialStream(page([legacy]),source()).items[0].id.length,200);assert.throws(()=>parseSocialStream(page([post('p'.repeat(201),30)]),source()));assert.throws(()=>parseSocialStream(page([],{viewerId:'v'.repeat(129)}),source({viewerId:'v'.repeat(129)})));
});
test('continuation cannot place a newer unregistered row after the existing page',async t=>{
 const f=fixture(t);f.reply=page([post('first',20)],{hasMore:true,nextCursor:'next'});await f.controller.load();f.reply=page([post('incorrect-next',30)]);assert.equal(await f.controller.more(),false);assert.deepEqual(f.controller.status().items.map(item=>item.id),['first']);
});

const settle=()=>new Promise(setImmediate);
async function twoPageNavigation(f){
 f.reply=page([post('old-first',30)],{hasMore:true,nextCursor:'old-next'});await f.controller.load();
 f.reply=page([community('old-second',10)]);await f.controller.more();return f.controller.navigation();
}

test('history carries only immutable controller-issued context and page count and rejects body snapshots or forged metadata',async t=>{
 const f=fixture(t),saved=await twoPageNavigation(f);assert.deepEqual(Object.keys(saved),['context','pages']);assert.equal(saved.pages,2);assert.equal(Object.isFrozen(saved),true);assert.equal(Object.isFrozen(saved.context),true);
 const bodySnapshot=f.controller.status();f.controller.invalidate();
 for(const forged of [bodySnapshot,structuredClone(saved),{context:saved.context,pages:999999999},null])assert.equal(await f.controller.restore(forged),null);
 assert.equal(f.controller.status().items.length,0);assert.equal(f.calls.length,2);
 for(const patch of [{viewerId:'other'},{origin:'https://other.example'},{filter:'thread'},{scope:'following'},{generation:{}}]){f.context={...saved.context,...patch};assert.equal(await f.controller.restore(saved),null);}
 const other=fixture(t);assert.equal(await other.controller.restore(saved),null);
});

test('restore clears old community bodies before reading and follows only freshly returned cursors for all saved pages',async t=>{
 const f=fixture(t),saved=await twoPageNavigation(f),first=deferred();let restored=0;
 f.reply=first.promise;const returning=f.controller.restore(saved,()=>restored++);
 assert.equal(f.controller.status().items.length,0);assert.equal(f.controller.element.querySelectorAll('[data-social-id]').length,0);assert.equal(f.calls.at(-1).args.cursor,null);
 f.reply=page([community('fresh-second',15)]);first.resolve(page([thread('fresh-first',40)],{hasMore:true,nextCursor:'fresh-next'}));
 assert.equal(await returning,true);assert.equal(restored,1);assert.deepEqual(f.calls.slice(2).map(call=>call.args.cursor),[null,'fresh-next']);assert.deepEqual(f.controller.status().items.map(item=>item.id),['fresh-first','fresh-second']);assert.equal(f.controller.navigation().pages,2);
});

test('a shortened current server result completes restoration safely without requesting removed pages',async t=>{
 const f=fixture(t),saved=await twoPageNavigation(f);f.reply=page([]);let restored=0;
 assert.equal(await f.controller.restore(saved,()=>restored++),true);assert.equal(f.calls.length,3);assert.equal(restored,1);assert.equal(f.controller.status().items.length,0);assert.equal(f.controller.navigation().pages,1);
});

test('failed continuation retains only newly verified rows and explicit retry rechecks the whole original return goal',async t=>{
 const f=fixture(t),saved=await twoPageNavigation(f);let reads=0,restored=0;
 f.reply=()=>++reads===1?page([thread('fresh-first',40)],{hasMore:true,nextCursor:'fresh-next'}):Promise.reject(Error('offline'));
 assert.equal(await f.controller.restore(saved,()=>restored++),false);assert.equal(restored,0);assert.equal(f.calls.length,4);assert.deepEqual(f.controller.status().items.map(item=>item.id),['fresh-first']);assert.equal(f.controller.navigation(),null);
 const retry=[...f.controller.element.querySelectorAll('button')].find(button=>button.textContent==='再取得');let retried=0;
 f.reply=()=>++retried===1?page([post('retry-first',50)],{hasMore:true,nextCursor:'retry-next'}):page([community('retry-second',20)]);
 assert.equal(await retry.onclick(),true);assert.equal(restored,1);assert.deepEqual(f.calls.slice(4).map(call=>call.args.cursor),[null,'retry-next']);assert.deepEqual(f.controller.status().items.map(item=>item.id),['retry-first','retry-second']);assert.equal(f.controller.navigation().pages,2);
});

test('partial fresh lane results remain visible but cannot complete return restoration',async t=>{
 const f=fixture(t),saved=await twoPageNavigation(f);let restored=0;
 f.reply=page([thread('fresh-partial',40)],{hasMore:true,nextCursor:'partial-fresh',failures:['community_post']});
 assert.equal(await f.controller.restore(saved,()=>restored++),false);assert.equal(restored,0);assert.deepEqual(f.controller.status().items.map(item=>item.id),['fresh-partial']);assert.equal(f.controller.navigation(),null);assert.equal(f.controller.element.querySelectorAll('[data-social-id="old-second"]').length,0);
});

test('source, actor, filter, view or disposal changes drop delayed restoration and its success callback',async t=>{
 for(const change of ['actor','origin','filter','view','dispose']){
  const f=fixture(t),saved=await twoPageNavigation(f),pending=deferred();let restored=0;f.reply=pending.promise;
  const returning=f.controller.restore(saved,()=>restored++);
  if(change==='actor')f.context={...f.context,viewerId:'other',generation:{}};else if(change==='origin')f.context={...f.context,origin:'https://other.example'};else if(change==='filter')f.context={...f.context,filter:'thread'};else if(change==='view')f.active=false;else f.controller.destroy();
  pending.resolve(page([post('late-private',40)]));assert.equal(await returning,false);assert.equal(restored,0);assert.equal(f.controller.status().items.length,0);assert.equal(f.controller.element.querySelectorAll('[data-social-id]').length,0);assert.equal(f.calls.length,3);
 }
});

test('old retry callbacks cannot reauthorize restoration after conditions change or a new paint supersedes them',async t=>{
 for(const change of ['actor','origin','filter','view','invalidate']){
  const f=fixture(t),saved=await twoPageNavigation(f);f.reply=Error('offline');let restored=0;await f.controller.restore(saved,()=>restored++);
  const oldRetry=[...f.controller.element.querySelectorAll('button')].find(button=>button.textContent==='再取得').onclick,reads=f.calls.length;
  if(change==='actor')f.context={...f.context,viewerId:'other',generation:{}};else if(change==='origin')f.context={...f.context,origin:'https://other.example'};else if(change==='filter')f.context={...f.context,filter:'thread'};else if(change==='view')f.active=false;else f.controller.invalidate();
  assert.equal(await oldRetry(),false);assert.equal(f.calls.length,reads);assert.equal(restored,0);
 }
});

test('manual load supersedes an in-flight return and manual more drops a failed return success callback',async t=>{
 const f=fixture(t),saved=await twoPageNavigation(f),pending=deferred();let restored=0;f.reply=pending.promise;const returning=f.controller.restore(saved,()=>restored++);
 f.reply=page([post('manual',45)]);assert.equal(await f.controller.load(),true);pending.resolve(page([post('late-return',40)]));assert.equal(await returning,false);assert.equal(restored,0);assert.deepEqual(f.controller.status().items.map(item=>item.id),['manual']);assert.equal(f.controller.navigation().pages,1);
 let reads=0;f.reply=()=>++reads===1?page([thread('fresh-first',40)],{hasMore:true,nextCursor:'fresh-next'}):Promise.reject(Error('offline'));
 await f.controller.restore(saved,()=>restored++);f.reply=page([community('manual-more',10)]);assert.equal(await f.controller.more(),true);assert.equal(restored,0);assert.deepEqual(f.controller.status().items.map(item=>item.id),['fresh-first','manual-more']);
});



test('issued navigation survives display invalidation but reauthorizes all rows before notifying the caller',async t=>{
 const f=fixture(t),saved=await twoPageNavigation(f);f.controller.invalidate();let restored=0;
 f.reply=page([]);assert.equal(await f.controller.restore(saved,()=>restored++),true);assert.equal(restored,1);assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).args.cursor,null);assert.equal(f.controller.status().items.length,0);
});

test('posts from the connected Hub carry no address line; another Hub, anonymous and guest posts keep theirs',()=>{
 const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');const {document}=new JSDOM('').window;
 const renderPost=()=>document.createElement('article');const item=(origin,identityMode='profile')=>({kind:'post',origin,payload:{identityMode}});
 const text=(value,primary)=>renderSocialItem(document,value,{renderPost,primaryOrigin:primary}).textContent;
 assert.equal(text(item('https://hub.example'),'https://hub.example'),'');
 assert.equal(text(item('https://other.example'),'https://hub.example'),'投稿 · https://other.example');
 assert.equal(text(item('https://hub.example','anonymous'),'https://hub.example'),'匿名の投稿');
});
