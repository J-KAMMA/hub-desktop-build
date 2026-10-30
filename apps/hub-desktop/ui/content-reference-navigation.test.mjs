import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {appendContentShare,contentShareReference} from './content-share-contract.mjs';
import {renderContentReferenceLinks} from './content-reference-links.mjs';

const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function actual(signature){const start=source.indexOf(signature),end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start,signature);return source.slice(start,end+2);}
const functions=[
 'function homeAccountSnapshot() {','function homeAccountCurrent(snapshot) {','function homeCanonicalOrigin(raw) {',
 'async function openSharedContentReference(','async function openHubPath(','function detailForHubPath(path) {','function postCard(post,','function decoratePostLinks(body) {',
].map(actual).join('\n');
const origin='https://hub.synthetic.invalid',tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(t){
 const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid/'}),calls=[],details=[],notices=[];
 const f={dom,calls,details,notices,origin,originRead:null,editedBody:null,browsers:[]};
 const ctx=vm.createContext({document:dom.window.document,URL,URLSearchParams,Event:dom.window.Event,setTimeout:()=>0,
  contentShareReference,renderContentReferenceLinks,
  desktopAccountLoaded:true,desktopAccount:{state:'registered',deviceId:'device-a',keyThumbprint:'synthetic-a'},homeAccountEpoch:{},selfProfileId:'viewer',
  paintAvatar(){},relTime:()=> 'now',icon:()=> '<svg></svg>',friendlyError:String,
  showNotice:message=>notices.push(message),openDetail:(name,ids,options)=>details.push({name,ids:Array.from(ids),title:options.title}),
  enterBrowser:async url=>f.browsers.push(url),
  navigateFrom:()=>assert.fail('Media references use existing details'),openVideoWatch:()=>assert.fail('Video reference uses existing detail'),
  invoke:async(name,args)=>{calls.push({name,args:args===undefined?undefined:structuredClone(args)});if(name==='hub_origin')return f.originRead?await f.originRead.promise:f.origin;
   if(name==='open_external')return;if(name==='hub_client_action'&&args.action==='edit_post')return{post:{body:f.editedBody??args.text}};
   assert.fail('Unexpected invoke '+name);},
 });
 vm.runInContext(functions,ctx);f.ctx=ctx;
 f.render=(path,body=appendContentShare('Discussion',path,origin),primaryDetail=false)=>{
  const card=ctx.postCard({id:'shared-post',body,authorName:'Author',authorHandle:'author',authorProfileId:'viewer',createdAt:'2026-10-08T00:00:00.000Z',referenced:null,images:[],tags:[]},{primaryDetail});
  dom.window.document.querySelector('main').replaceChildren(card);return card;
 };
 f.event=(anchor,type='click',options={})=>{const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,...options});anchor.dispatchEvent(event);return event;};
 f.change=kind=>{if(kind==='actor')ctx.desktopAccount={state:'registered',deviceId:'device-b',keyThumbprint:'synthetic-b'};else{f.origin='https://other.synthetic.invalid';ctx.homeAccountEpoch={};}};
 t.after(()=>dom.window.close());return f;
}

test('GitHub fixed references open the Hub browser; modifier actions retain the explicit external path',async t=>{
 for(const width of [40,64])for(const modified of [false,true]){
  const f=fixture(t),href='https://github.com/owner/repo/commit/'+'a'.repeat(width),card=f.render(null,'Discussion\n\n'+href);
  f.event(card.querySelector('.post-body a'),'click',modified?{ctrlKey:true}:{});await tick();
  assert.deepEqual(f.browsers,modified?[]:[href]);assert.deepEqual(f.details,[]);
  assert.deepEqual(f.calls.map(call=>call.name),modified?['hub_origin','open_external']:['hub_origin']);
 }
});

function nativeOptions(f){
 const start=source.indexOf('const nativeGitHub = initNativeGitHub('),end=source.indexOf('\nconst researchWorkspace',start);assert.ok(start>=0&&end>start);
 f.ctx.initNativeGitHub=options=>{f.native=options;return{};};f.ctx.offerPublicContentShare=()=>assert.fail('Only original reference activation is under test');
 f.ctx.currentView='research';vm.runInContext(source.slice(start,end),f.ctx);
 const scope={epoch:f.ctx.homeAccountEpoch,key:JSON.stringify([f.ctx.desktopAccount.state,f.ctx.desktopAccount.deviceId??null,f.ctx.desktopAccount.keyThumbprint??null])};
 return ()=>f.native.isCurrent(scope);
}
test('actual Native panel routes normal and modifier activation consistently, including without a registered account',async t=>{
 for(const registered of [true,false])for(const [type,options]of [['click',{}],['click',{ctrlKey:true}],['click',{metaKey:true}],['click',{shiftKey:true}],['auxclick',{button:1}]]){
  const f=fixture(t);if(!registered){f.ctx.desktopAccount={state:'unregistered',deviceId:null,keyThumbprint:null};f.ctx.desktopAccountLoaded=false;}
  const valid=nativeOptions(f),href='https://github.com/owner/repo/commit/'+'a'.repeat(40),event=new f.dom.window.MouseEvent(type,options);
  await f.native.openReference(href,event,valid);const modified=type==='auxclick'||options.ctrlKey||options.metaKey||options.shiftKey;
  assert.deepEqual(f.browsers,modified?[]:[href]);assert.deepEqual(f.calls.map(call=>call.name),modified?['hub_origin','open_external']:['hub_origin']);
  if(modified)assert.equal(f.calls[1].args.url,href);
 }
});
test('actual Native panel cancels late original navigation after actor, generation or view changes',async t=>{
 for(const change of [f=>f.change('actor'),f=>f.change('origin'),f=>{f.ctx.currentView='feed';}]){
  const f=fixture(t),valid=nativeOptions(f);f.originRead=deferred();
  const work=f.native.openReference('https://github.com/owner/repo/commit/'+'b'.repeat(64),new f.dom.window.MouseEvent('auxclick',{button:1}),valid);
  change(f);f.originRead.resolve(origin);await work;assert.deepEqual(f.browsers,[]);assert.deepEqual(f.calls.map(call=>call.name),['hub_origin']);
 }
});

test('actual preview callback captures the account before awaiting the origin and rejects an old actor',async t=>{
 const f=fixture(t),start=source.indexOf('contentSharePreview=createContentShare('),end=source.indexOf('\nfor(const name of',start);
 assert.ok(start>=0&&end>start);f.ctx.composer={form:{querySelector:()=>({})},text:{}};
 f.ctx.contentShareContext=()=>{};f.ctx.createContentShare=options=>{f.previewOptions=options;return{};};
 vm.runInContext(source.slice(start,end),f.ctx);f.originRead=deferred();
 const work=f.previewOptions.onOpenReference('https://github.com/owner/repo/commit/'+'a'.repeat(40),()=>true);
 f.change('actor');f.originRead.resolve(origin);await work;
 assert.deepEqual(f.browsers,[]);assert.deepEqual(f.details,[]);assert.deepEqual(f.calls.map(call=>call.name),['hub_origin']);
});

const targets=[
 ['/v2/articles/article-a','article',['article-a']],
 ['/v2/videos/video-a','video',['video-a']],
 ['/v2/music/works/music%3A00000000-0000-4000-8000-000000000001','music_work',['music:00000000-0000-4000-8000-000000000001']],
 ['/v2/research/rp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?document=paper&version=7','research_revision',['rp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','paper','7']],
];
test('actual normal post links open article, video, music and exact research version in existing Native details',async t=>{
 for(const [path,name,ids]of targets){const f=fixture(t),card=f.render(path),body=card.querySelector('.post-body'),anchor=body.querySelector('a');
  assert.equal(body.textContent,appendContentShare('Discussion',path,origin).replace(anchor.title,anchor.textContent));assert.ok(anchor);assert.deepEqual(f.calls,[]);
  const event=f.event(anchor);await tick();assert.equal(event.defaultPrevented,true);assert.equal(f.details.length,1);
  assert.equal(f.details[0].name,name);assert.deepEqual(f.details[0].ids,ids);assert.deepEqual(f.calls.map(call=>call.name),['hub_origin']);assert.deepEqual(f.notices,[]);
 }
});
test('same content ID on a different Hub opens only the exact external reference',async t=>{
 const f=fixture(t),url='https://other.synthetic.invalid/v2/articles/same',card=f.render('/v2/articles/same','Discussion\n\n'+url);
 f.event(card.querySelector('.post-body a'));await tick();assert.deepEqual(f.details,[]);
 assert.deepEqual(f.calls,[{name:'hub_origin',args:undefined},{name:'open_external',args:{url}}]);
});
test('reference clicks are separate from parent post opening; Ctrl, Meta, Shift and middle click use exact external URL',async t=>{
 for(const [type,options]of [['click',{ctrlKey:true}],['click',{metaKey:true}],['click',{shiftKey:true}],['auxclick',{button:1}]]){
  const f=fixture(t),path='/v2/videos/video-a',card=f.render(path),event=f.event(card.querySelector('.post-body a'),type,options);await tick();
  assert.equal(event.defaultPrevented,true);assert.deepEqual(f.details,[]);assert.deepEqual(f.calls.map(call=>call.name),['hub_origin','open_external']);assert.equal(f.calls[1].args.url,origin+path);
 }
 const f=fixture(t),card=f.render('/v2/articles/a');f.event(card.querySelector('.post-body'));assert.equal(f.details.length,1);assert.equal(f.details[0].name,'post');assert.deepEqual(f.details[0].ids,['shared-post']);assert.deepEqual(f.calls,[]);
});
test('actual account and origin guards suppress old reference callbacks before and after origin acquisition',async t=>{
 for(const kind of ['actor','origin'])for(const timing of ['before','after']){
  const f=fixture(t),card=f.render('/v2/articles/a'),anchor=card.querySelector('.post-body a');
  if(timing==='before'){f.change(kind);f.event(anchor);}
  else{f.originRead=deferred();f.event(anchor);await tick();assert.equal(f.calls.length,1);f.change(kind);f.originRead.resolve(origin);}
  await tick();assert.deepEqual(f.details,[]);assert.equal(f.calls.some(call=>call.name==='open_external'),false);assert.equal(f.calls.length,timing==='before'?0:1);assert.deepEqual(f.notices,[]);
 }
});
test('actual edit cancellation restores original references and edit save restores returned-body target links',async t=>{
 const f=fixture(t),original=appendContentShare('Original draft','/v2/articles/a',origin),card=f.render('/v2/articles/a',original),body=card.querySelector('.post-body');
 const edit=()=>[...card.querySelectorAll('button')].find(button=>button.textContent==='編集').click();
 edit();assert.equal(body.querySelector('a'),null);body.querySelector('textarea').value='Unsent change';
 [...body.querySelectorAll('button')].find(button=>button.textContent==='取消').click();assert.equal(body.textContent,original.replace(body.querySelector('a').title,body.querySelector('a').textContent));assert.equal(body.querySelector('a').href,origin+'/v2/articles/a');assert.deepEqual(f.details,[]);
 edit();const proposed=appendContentShare('Changed draft','/v2/music/works/catalog',origin);body.querySelector('textarea').value=proposed;
 const saved=appendContentShare('Server confirmed','/v2/research/rp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?document=paper&version=2',origin);f.editedBody=saved;
 [...body.querySelectorAll('button')].find(button=>button.textContent==='保存').click();await tick();assert.equal(body.textContent,saved.replace(body.querySelector('a')?.title??' ',body.querySelector('a')?.textContent??''));assert.equal(body.querySelector('textarea'),null);assert.deepEqual(f.details,[]);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'hub_client_action');assert.equal(f.calls[0].args.text,proposed);
 f.event(body.querySelector('a'));await tick();assert.equal(f.details.length,1);assert.equal(f.details[0].name,'research_revision');assert.deepEqual(f.details[0].ids,['rp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','paper','2']);
});

test('right-click preserves the context menu and starts no reference navigation',async t=>{
 const f=fixture(t),card=f.render('/v2/articles/a'),event=f.event(card.querySelector('.post-body a'),'auxclick',{button:2});
 await tick();assert.equal(event.defaultPrevented,false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.details,[]);
});

test('removing the card or editing away its anchor during origin acquisition suppresses the pending navigation',async t=>{
 for(const mode of ['card','anchor']){
  const f=fixture(t),card=f.render('/v2/articles/a'),anchor=card.querySelector('.post-body a');f.originRead=deferred();
  f.event(anchor);await tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'hub_origin');
  if(mode==='card')card.remove();else [...card.querySelectorAll('button')].find(button=>button.textContent==='編集').click();
  assert.equal(anchor.isConnected,false);f.originRead.resolve(origin);await tick();
  assert.deepEqual(f.details,[]);assert.deepEqual(f.calls.map(call=>call.name),['hub_origin']);assert.deepEqual(f.notices,[]);
 }
});

test('shared Git references return to the exact Native commit or comparison and preserve remote source anchors',async t=>{
 const project='rp_'+ 'a'.repeat(32);
 for(const width of [40,64])for(const compare of [false,true]){
  const commit='b'.repeat(width),base='c'.repeat(width),path=`/v2/research/${project}?commit=${commit}${compare?`&base=${base}`:''}#git`,f=fixture(t);
  const card=f.render(path);f.event(card.querySelector('.post-body a'));await tick();
  assert.deepEqual(f.notices,[]);assert.equal(f.details.length,1);assert.equal(f.details[0].name,compare?'research_git_compare':'research_git_commit');assert.deepEqual(f.details[0].ids,compare?[project,commit,base]:[project,commit]);
  const remote=fixture(t),href='https://other.synthetic.invalid'+path,otherCard=remote.render(path,'Discussion\n\n'+href);
  remote.event(otherCard.querySelector('.post-body a'));await tick();assert.deepEqual(remote.details,[]);assert.deepEqual(remote.calls.at(-1),{name:'open_external',args:{url:href}});
 }
});
