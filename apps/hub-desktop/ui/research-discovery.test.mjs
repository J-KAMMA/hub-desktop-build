import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {appendResearchBacklinks,appendResearchUpdates} from './research-discovery.mjs';
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const update=(overrides={})=>({kind:'research',id:'doc',title:'<img>研究😀',projectId:'rp',projectTitle:'研究プロジェクト',version:7,href:'/v2/research/rp?document=doc&version=7',updatedAt:'2026-10-04T12:00:00Z',...overrides});
test('feed updates prepend without replacing posts and clicks always use displayed version including normalized legacy links',t=>{
 const dom=new JSDOM('<main><article>EXISTING POST</article></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main'),post=target.firstChild,opened=[];
 const root=appendResearchUpdates(target,[update(),update({projectId:'other',href:'/v2/research/other?document=doc',version:2}),update({kind:'article',id:'doc',href:'/v2/articles/doc'}),update({kind:'video',id:'doc',href:'/v2/videos/doc'}),update({kind:'music',id:'doc',href:`/v2/music?q=${encodeURIComponent('<img>研究😀')}`})],{openLink:(...args)=>opened.push(args)});
 assert.equal(target.firstChild,root);assert.equal(target.lastChild,post);assert.equal(root.querySelector('img,a'),null);assert.equal(root.querySelector('h3').textContent,'作品・研究の更新');const buttons=[...root.querySelectorAll('.feed-update-row')];assert.equal(buttons.length,5);assert.match(buttons[0].textContent,/v7 — 研究プロジェクト/);assert.match(buttons[1].textContent,/v2 — 研究プロジェクト/);buttons.forEach(button=>button.click());assert.deepEqual(opened.map(([href])=>href),['/v2/research/rp?document=doc&version=7','/v2/research/other?document=doc&version=2','/v2/articles/doc','/v2/videos/doc','/v2/music/works/doc']);
});
test('feed malformed shape, paths, versions, titles, dates, duplicates and array bounds render no actions',t=>{
 const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main');
 const invalid=[null,{},[null],[update({kind:'thread'})],[update({id:'x'.repeat(129)})],[update({projectId:'../rp'})],[update({title:'\ud800'})],[update({title:'bad\u0085'})],[update({title:'x'.repeat(241)})],[update({projectTitle:''})],[update({projectTitle:'\udc00'})],[update({version:0})],[update({version:1.5})],[update({version:Number.MAX_SAFE_INTEGER+1})],[update({projectId:undefined})],[update({href:'https://evil.example/v2/research/rp?document=doc&version=7'})],[update({href:'/v2/research/rp?document=doc&version=8'})],[update({href:'/v2/research/rp?version=7&document=doc'})],[update({kind:'article',href:'javascript:run()'})],[update({kind:'music',href:'/v2/music?q=other'})],[update({updatedAt:'invalid'})],[update({updatedAt:'2026-10-04\u007f'})],[update({updatedAt:'x'.repeat(65)})],[update(),update()],Array.from({length:21},(_,i)=>update({id:`doc${i}`,href:`/v2/research/rp?document=doc${i}&version=7`}))];
 for(const value of invalid){const root=appendResearchUpdates(target,value,{openLink:()=>assert.fail('invalid action')});assert.ok(root);assert.equal(root.querySelector('button,a'),null);assert.match(root.querySelector('[role="status"]').textContent,/確認できません/);root.remove();}
 const root=appendResearchUpdates(target,Array.from({length:20},(_,i)=>update({id:`doc${i}`,title:'😀'.repeat(120),version:Number.MAX_SAFE_INTEGER,href:`/v2/research/rp?document=doc${i}&version=${Number.MAX_SAFE_INTEGER}`})));assert.equal(root.querySelectorAll('.feed-update-row').length,20);assert.equal(root.querySelectorAll('.feed-update-row:not([hidden])').length,5);
});
test('feed empty or stale render adds no section and captured actions are blocked after current or target change',t=>{
 const dom=new JSDOM('<main><article>POST</article></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main'),opened=[];let current=true;
 assert.equal(appendResearchUpdates(target,[]),null);assert.equal(target.children.length,1);assert.equal(appendResearchUpdates(target,[update()],{isCurrent:()=>false}),null);
 const root=appendResearchUpdates(target,[update()],{isCurrent:()=>current,openLink:(...args)=>opened.push(args)}),button=root.querySelector('button');current=false;button.click();assert.deepEqual(opened,[]);current=true;root.remove();button.click();assert.deepEqual(opened,[]);target.append(root);target.remove();button.click();assert.deepEqual(opened,[]);assert.equal(appendResearchUpdates(target,[update()]),null);
});
function fixture(t,options={}){
 const dom=new JSDOM('<main></main>'),document=dom.window.document,target=document.querySelector('main'),calls=[],opened=[];
 const view=appendResearchBacklinks(target,{kind:'thread',id:'same',invoke:async(name,args)=>{calls.push({name,args});return {projects:[{id:'rp',title:'<img>公開研究😀'}]};},openProject:project=>opened.push(project),...options});t.after(()=>{view.dispose();dom.window.close();});return {...view,dom,target,calls,opened};
}
test('fixed backlinks read shows purpose/loading and opens only validated literal project IDs',async t=>{
 const f=fixture(t);assert.match(f.root.textContent,/スレッドに関連するプロジェクト/);assert.match(f.root.textContent,/確認しています/);assert.equal(f.root.getAttribute('aria-busy'),'true');await f.ready;
 assert.deepEqual(f.calls,[{name:'hub_detail',args:{name:'research_backlinks_thread',ids:['same']}}]);assert.equal(f.root.querySelector('img,a'),null);assert.equal(f.root.querySelector('button').textContent,'<img>公開研究😀');f.root.querySelector('button').click();assert.deepEqual(f.opened,[{id:'rp',title:'<img>公開研究😀'}]);assert.equal(f.root.getAttribute('aria-busy'),'false');
});
test('all five fixed kinds are independent and invalid target/kind never invoke IPC',async t=>{
 for(const kind of ['article','video','hubpedia','thread','community']){const f=fixture(t,{kind});await f.ready;assert.equal(f.calls[0].args.name,`research_backlinks_${kind}`);}
 for(const options of [{kind:'__proto__'},{kind:'post'},{kind:'thread;delete'},{id:'x'.repeat(241)},{id:'bad\u0085'},{id:'\ud800'},{id:'x/y'},{id:'..'},{id:'https://evil.example'},{id:' spaced '}]){const f=fixture(t,options);await f.ready;assert.deepEqual(f.calls,[]);assert.equal(f.root.querySelector('a'),null);assert.equal(f.root.querySelector('button').textContent,'再試行');}
});
test('malformed, external paths, duplicates and UTF16 or count bounds never produce project actions',async t=>{
 const invalid=[null,[],{}, {projects:{}},{projects:[null]},{projects:[{id:'p',title:''}]},{projects:[{id:'p',title:'x'.repeat(241)}]},{projects:[{id:'p',title:'\ud800'}]},{projects:[{id:'p',title:'bad\u0085'}]},{projects:[{id:'p',title:'valid',href:'https://evil.example'}]},{projects:[{id:'p',title:'valid',href:'/v2/research/other'}]},{projects:[{id:'p',title:'valid',extra:'not wire'}]},{projects:[{id:'../p',title:'valid'}]},{projects:[{id:'研究',title:'valid'}]},{projects:[{id:'x'.repeat(129),title:'valid'}]},{projects:[{id:'p',title:'valid'},{id:'p',title:'duplicate'}]},{projects:Array.from({length:21},(_,i)=>({id:String(i),title:'valid'}))}];
 for(const value of invalid){const f=fixture(t,{invoke:async()=>value});await f.ready;assert.equal(f.root.querySelectorAll('button').length,1);assert.equal(f.root.querySelector('button').textContent,'再試行');assert.equal(f.root.querySelector('a'),null);assert.match(f.root.textContent,/取得できません/);}
 const maximum=fixture(t,{invoke:async()=>({projects:Array.from({length:20},(_,i)=>({id:`p${i}`,title:'😀'.repeat(120),href:`/v2/research/p${i}`}))})});await maximum.ready;assert.equal(maximum.root.querySelectorAll('button').length,20);
});
test('empty related result is hidden and read failure can retry explicitly with exact same fixed request',async t=>{
 let count=0;const calls=[],f=fixture(t,{invoke:async(name,args)=>{calls.push({name,args});if(count++===0)throw Error('offline');return {projects:[]};}});await f.ready;assert.equal(f.root.hidden,false);await f.root.querySelector('button').onclick();assert.equal(f.root.hidden,true);assert.deepEqual(calls[0],calls[1]);assert.equal(calls.length,2);
});
test('non-Error IPC rejections remain visible errors with explicit retry and no results',async t=>{
 for(const error of [null,undefined,'network_unavailable']){const f=fixture(t,{invoke:()=>Promise.reject(error)});await f.ready;assert.match(f.root.textContent,/取得できません/);assert.equal(f.root.querySelector('button').textContent,'再試行');assert.deepEqual(f.opened,[]);}
});
test('15 second deadline is visible and timeout retry ignores the old response',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const pending=deferred();let calls=0;const f=fixture(t,{invoke:async()=>++calls===1?pending.promise:{projects:[{id:'new',title:'CURRENT'}]}});await Promise.resolve();await Promise.resolve();t.mock.timers.tick(14999);assert.match(f.root.textContent,/確認しています/);t.mock.timers.tick(1);await f.ready;assert.match(f.root.textContent,/時間切れ/);await f.root.querySelector('button').onclick();pending.resolve({projects:[{id:'old',title:'STALE'}]});await tick();assert.match(f.root.textContent,/CURRENT/);assert.doesNotMatch(f.root.textContent,/STALE/);assert.equal(calls,2);
});
test('superseded reads, target removal, view change, account change and disposal cannot restore or open old results',async t=>{
 const first=deferred();let count=0;const f=fixture(t,{invoke:async()=>++count===1?first.promise:{projects:[{id:'new',title:'CURRENT'}]}});await tick();await f.retry();await f.ready;first.resolve({projects:[{id:'old',title:'STALE'}]});await tick();assert.match(f.root.textContent,/CURRENT/);assert.doesNotMatch(f.root.textContent,/STALE/);
 let current=true;const opened=[],ready=fixture(t,{isCurrent:()=>current,openProject:project=>opened.push(project)});await ready.ready;const captured=ready.root.querySelector('button');current=false;captured.click();assert.deepEqual(opened,[]);
 for(const mode of ['target','view','account','dispose']){const pending=deferred();let live=true;const stale=fixture(t,{invoke:()=>pending.promise,isCurrent:()=>live});await tick();if(mode==='target')stale.target.replaceChildren();else if(mode==='view')live=false;else if(mode==='account')stale.dom.window.dispatchEvent(new stale.dom.window.Event('hub-account-changed'));else stale.dispose();pending.resolve({projects:[{id:'old',title:'PRIVATE_OLD'}]});await stale.ready;assert.doesNotMatch(stale.root.textContent,/PRIVATE_OLD/);assert.equal(stale.root.querySelector('button'),null);}
});

test('same-title music updates and legacy responses open exact independent work IDs',t=>{
 const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main'),opened=[];
 const ids=['song-one','song-two','music:00000000-0000-4000-8000-000000000001'];
 const items=ids.map((id,index)=>update({kind:'music',id,title:'Same title',href:index===1?'/v2/music?q=Same%20title':'/v2/music/works/'+encodeURIComponent(id)}));
 const root=appendResearchUpdates(target,items,{openLink:href=>opened.push(href)});
 assert.equal(root.querySelectorAll('.feed-update-row').length,3);root.querySelectorAll('.feed-update-row').forEach(button=>button.click());
 assert.deepEqual(opened,ids.map(id=>'/v2/music/works/'+encodeURIComponent(id)));assert.equal(new Set(opened).size,3);
});
test('music update links reject malformed identifiers and references to other works or origins',t=>{
 const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main');
 const ids=['..','x/y','x?y','x#y','x%2Fy',' bad','x'.repeat(129),'music:not-a-uuid','\ud800'];
 const rows=ids.map(id=>update({kind:'music',id,title:'Same title',href:'/v2/music/works/'+encodeURIComponent(id.toWellFormed())}));
 rows.push(update({kind:'music',id:'one',href:'/v2/music/works/two'}),update({kind:'music',id:'one',href:'https://other.example/v2/music/works/one'}));
 for(const item of rows){target.replaceChildren();const root=appendResearchUpdates(target,[item],{openLink:()=>assert.fail('Invalid music opened')});assert.equal(root.querySelector('button'),null);assert.ok(root.querySelector('[role="status"]'));}
});


test('delayed backlink parent navigation uses a boolean guard for source, view, actor and reread changes',async t=>{
 for(const mode of [null,'button','button-moved','root','root-moved','target','view','actor','retry','account','dispose']){
  const pending=deferred(),opened=[];let current=true,epoch={},capturedEpoch=epoch,guard;
  const f=fixture(t,{isCurrent:()=>current&&epoch===capturedEpoch,openProject:async(project,isCurrent)=>{guard=isCurrent;await pending.promise;if(!isCurrent())return false;opened.push(project);return true;}});
  await f.ready;const button=f.root.querySelector('button'),work=button.onclick();assert.equal(typeof guard,'function');assert.equal(guard(),true);assert.equal(typeof guard(),'boolean');
  if(mode==='button')button.remove();else if(mode==='button-moved')f.target.append(button);else if(mode==='root')f.root.remove();else if(mode==='root-moved'){const other=f.dom.window.document.createElement('section');f.target.append(other);other.append(f.root);}else if(mode==='target')f.target.remove();else if(mode==='view')current=false;else if(mode==='actor')epoch={};else if(mode==='retry')await f.retry();else if(mode==='account')f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));else if(mode==='dispose')f.dispose();
  assert.equal(guard(),mode===null);pending.resolve();assert.equal(await work,mode===null);
  assert.deepEqual(opened,mode===null?[{id:'rp',title:'<img>公開研究😀'}]:[]);
 }
});

test('delayed feed parent navigation retains fixed reference only while button, target and context remain current',async t=>{
 for(const mode of [null,'button','button-moved','root','root-moved','target','view','actor','refresh']){
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main'),pending=deferred(),opened=[];let current=true,epoch={},capturedEpoch=epoch,guard;
  const root=appendResearchUpdates(target,[update()],{isCurrent:()=>current&&epoch===capturedEpoch,openLink:async(href,title,isCurrent)=>{guard=isCurrent;await pending.promise;if(!isCurrent())return false;opened.push({href,title});return true;}}),button=root.querySelector('button'),work=button.onclick();
  assert.equal(typeof guard,'function');assert.equal(guard(),true);assert.equal(typeof guard(),'boolean');
  if(mode==='button')button.remove();else if(mode==='button-moved')target.append(button);else if(mode==='root')root.remove();else if(mode==='root-moved'){const other=dom.window.document.createElement('section');target.append(other);other.append(root);}else if(mode==='target')target.remove();else if(mode==='view')current=false;else if(mode==='actor')epoch={};else if(mode==='refresh'){target.replaceChildren();appendResearchUpdates(target,[update({version:8,href:'/v2/research/rp?document=doc&version=8'})]);}
  assert.equal(guard(),mode===null);pending.resolve();assert.equal(await work,mode===null);
  assert.deepEqual(opened,mode===null?[{href:'/v2/research/rp?document=doc&version=7',title:'<img>研究😀'}]:[]);
 }
});

test('captured discovery guards fail closed on current-check errors and never authorize detached source buttons',async t=>{
 let throws=false;const opened=[],backlinks=fixture(t,{isCurrent:()=>{if(throws)throw Error('scope unavailable');return true;},openProject:(_project,current)=>opened.push(current)});await backlinks.ready;
 const old=backlinks.root.querySelector('button');old.onclick();const guard=opened[0];throws=true;assert.equal(guard(),false);assert.doesNotThrow(()=>old.onclick());assert.equal(opened.length,1);throws=false;
 const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main'),feed=appendResearchUpdates(target,[update()],{isCurrent:()=>{if(throws)throw Error('scope unavailable');return true;},openLink:(_href,_title,current)=>opened.push(current)}),button=feed.querySelector('button');button.onclick();const feedGuard=opened[1];throws=true;assert.equal(feedGuard(),false);assert.doesNotThrow(()=>button.onclick());assert.equal(opened.length,2);
});
test('feed updates show five compact rows, expand, and remember collapse per device',t=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.example/'});t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main'),opened=[];
 const items=Array.from({length:12},(_,i)=>update({kind:'video',id:`v${i}`,title:`Title ${i}`,href:`/v2/videos/v${i}`}));
 const root=appendResearchUpdates(target,items,{openLink:href=>opened.push(href)});
 const visible=()=>[...root.querySelectorAll('.feed-update-row')].filter(row=>!row.hidden);
 assert.equal(visible().length,5);assert.equal(root.querySelector('.feed-update-kind').textContent,'動画');assert.equal(root.querySelector('.feed-update-row').getAttribute('aria-label'),'動画 · Title 0');
 const more=root.querySelector('.feed-updates-more'),fold=root.querySelector('.feed-updates-fold');assert.match(more.textContent,/すべて見る/);
 more.click();assert.equal(visible().length,12);assert.equal(more.textContent,'閉じる');more.click();assert.equal(visible().length,5);
 visible()[0].click();assert.deepEqual(opened,['/v2/videos/v0']);
 fold.click();assert.equal(root.querySelector('.feed-updates-list').hidden,true);assert.equal(fold.getAttribute('aria-expanded'),'false');assert.equal(dom.window.localStorage.getItem('hub.desktop.feedUpdatesCollapsed'),'1');
 const again=appendResearchUpdates(target,items);assert.equal(again.querySelector('.feed-updates-list').hidden,true);again.querySelector('.feed-updates-fold').click();assert.equal(dom.window.localStorage.getItem('hub.desktop.feedUpdatesCollapsed'),'0');
 const few=appendResearchUpdates(target,items.slice(0,3));assert.equal(few.querySelector('.feed-updates-more'),null);
});
