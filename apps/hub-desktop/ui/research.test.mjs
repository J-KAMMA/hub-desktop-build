import { test } from "node:test";
import assert from "node:assert/strict";
import { initResearch, filterResearchObjects, searchResearchProjects, renderResearchProject, renderResearchDocument, researchLinkContext } from "./research.mjs";
import { JSDOM } from 'jsdom';
function researchIndexFixture(t){
 const dom=new JSDOM('<section class="research-index-tools"><input id="research-query"><button id="research-refresh">更新</button><button id="research-create-web">作成</button></section><p id="research-state"></p><main id="research-results"></main>',{url:'http://localhost'});
 t.after(()=>dom.window.close());const document=dom.window.document,calls=[],f={dom,document,calls,source:'all',local:async()=>({projects:[],hasMore:false}),remote:async()=>[],invalidations:0,opened:[]};
 f.network={ready:Promise.resolve(),context:()=>f.source,includePrimary:()=>f.source==='all',invalidate:()=>f.invalidations++,load:async(kind,query)=>{calls.push(['remote',kind,query]);return f.remote(query);},card:item=>{const card=document.createElement('article');card.textContent=`${item.origin}: ${item.title}`;return card;}};
 f.view=initResearch({document,network:f.network,invoke:async(name,args)=>{calls.push([name,args]);return f.local(args);},openProject:project=>f.opened.push(project),changed:()=>{},friendlyError:error=>error.message,openWeb:()=>{}});f.query=document.querySelector('#research-query');return f;
}
test('index sends applied query to remote search and renders remote row despite primary failure',async t=>{
 const f=researchIndexFixture(t);f.query.value=' \ufeff older research ';f.local=async()=>{throw Error('primary offline');};f.remote=async()=>[{origin:'https://b.example',id:'old',title:'older research found beyond latest30'}];
 await f.view.load();assert.deepEqual(f.calls[0],['hub_resource',{resource:'research',query:'older research',offset:0}]);assert.deepEqual(f.calls[1],['remote','research','older research']);
 assert.match(f.document.querySelector('#research-results').textContent,/b.example: older research found beyond latest30/);assert.match(f.document.querySelector('#research-state').textContent,/primary offline/);assert.equal(f.document.querySelector('#research-state button').textContent,'再試行');
 assert.match(f.document.body.textContent,/検索語は選択したHubの公開研究検索へ送ります/);
 // A retry belongs to the applied term even if a programmatic draft change occurs without input.
 f.query.value='unapplied';f.document.querySelector('#research-state button').click();await new Promise(setImmediate);assert.deepEqual(f.calls.at(-1),['remote','research','older research']);assert.match(f.document.querySelector('#research-results').textContent,/found beyond latest30/);
});
test('an empty project index uses the shared state panel and list layout',async t=>{
 const f=researchIndexFixture(t);await f.view.load();
 const panel=f.document.querySelector('#research-results > .state-panel');
 assert.ok(panel,'the empty project index uses .state-panel');
 assert.match(panel.textContent,/表示できるプロジェクトはまだありません/);
 assert.ok(panel.querySelector('.state-title'));
 assert.ok(panel.querySelector('.state-body'));
});
test('selected extra Hub excludes primary and paging retains applied remote rows without another search',async t=>{
 const f=researchIndexFixture(t);f.source='https://b.example';f.query.value='applied';f.remote=async()=>[{origin:f.source,title:'applied remote'}];await f.view.load();assert.deepEqual(f.calls,[['remote','research','applied']]);assert.match(f.document.querySelector('main').textContent,/applied remote/);
 f.source='all';f.calls.length=0;let count=0;f.local=async({offset})=>({projects:[{id:String(offset),title:`local ${offset}`}],hasMore:count++===0});await f.view.load();
 [...f.document.querySelectorAll('button')].find(button=>button.textContent==='続きを表示').click();await new Promise(setImmediate);assert.equal(f.calls.filter(([name])=>name==='remote').length,1);assert.match(f.document.querySelector('main').textContent,/local 0/);assert.match(f.document.querySelector('main').textContent,/local 1/);assert.match(f.document.querySelector('main').textContent,/applied remote/);
});
test('raw invalid query prevents all reads and clears previous rows',async t=>{
 const f=researchIndexFixture(t);f.remote=async()=>[{origin:'b',title:'old'}];await f.view.load();f.calls.length=0;
 for(const term of ['\ud800','bad\u0085query',' '+'a'.repeat(100),'a '.repeat(8)+'a']){f.query.value=term;await f.view.load();assert.deepEqual(f.calls,[]);assert.equal(f.document.querySelector('main').children.length,0);assert.match(f.document.querySelector('#research-state').textContent,/検索語は100文字/);}
});
test('query clear, source and account changes ignore late rows; account cancels pending debounce',async t=>{
 const f=researchIndexFixture(t);let resolve;f.remote=()=>new Promise(done=>resolve=done);
 const old=f.view.load();await new Promise(setImmediate);f.query.value='';f.query.dispatchEvent(new f.dom.window.Event('input'));resolve([{origin:'b',title:'stale clear'}]);await old;assert.equal(f.document.querySelector('main').children.length,0);
 f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));f.calls.length=0;await new Promise(done=>setTimeout(done,280));assert.deepEqual(f.calls,[]);
 for(const mutate of [()=>{f.source='https://b.example';},()=>f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'))]){const pending=f.view.load();await new Promise(setImmediate);mutate();resolve([{origin:'b',title:'stale boundary'}]);await pending;assert.doesNotMatch(f.document.querySelector('main').textContent,/stale/);}
});
test('IME defers remote query until composition completes and Enter applies it',async t=>{
 const f=researchIndexFixture(t);f.query.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart'));f.query.value='研究';f.query.dispatchEvent(new f.dom.window.InputEvent('input',{isComposing:true}));f.query.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',isComposing:true}));await new Promise(done=>setTimeout(done,280));assert.deepEqual(f.calls,[]);
 f.query.dispatchEvent(new f.dom.window.CompositionEvent('compositionend'));f.query.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter'}));await new Promise(setImmediate);assert.deepEqual(f.calls.at(-1),['remote','research','研究']);f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));
});

test('research opens the selected document and renders code as inert text', () => {
  const dom = new JSDOM('<main></main>');
  const target = dom.window.document.querySelector('main');
  const item = {id:'doc',projectId:'project',title:'Source',head:2};
  let opened;
  renderResearchProject(target,{project:{id:'project'},workspace:{documents:[item],links:[{title:'Discussion',href:'/v2/threads/topic'}]}},(...args)=>{opened=args;},path=>{opened=path;},path=>{opened=path;});
  [...target.querySelectorAll('button')].find(button=>button.textContent==='論文PDFをWebで開く').click();
  assert.equal(opened,'/v2/research/project#pdfs');
  [...target.querySelectorAll('button')].find(button=>button.textContent==='GitリポジトリをWebで開く').click();
  assert.equal(opened,'/v2/research/project#git');
  [...target.querySelectorAll('button')].find(button=>button.textContent==='関連資料をWebで開く').click();
  assert.equal(opened,'/v2/research/project#references');
  assert.deepEqual([...target.querySelectorAll('[data-research-section]')].map(node=>node.dataset.researchSection),['概要','文書・コード','資料・作品・議論','研究成果','主張と根拠']);
  target.querySelector('a').click();
  assert.equal(opened,'/v2/threads/topic');
  [...target.querySelectorAll('button')].find(button=>button.textContent==='Source · v2').click();
  assert.deepEqual(opened,['project',item]);
  renderResearchDocument(target,{document:item,revision:{version:2,body:'<script>run()</script>',summary:'Change'},history:[{version:1,summary:'First'},{version:2,summary:'Change'}]},path=>{opened=path;});
  assert.equal(target.querySelector('script'),null);
  assert.equal(target.querySelector('pre').textContent,'<script>run()</script>');
  target.querySelector('button').click();
  assert.equal(opened,'/v2/research/project?document=doc');
  dom.window.close();
});

test("research categories retain code, paper and experiment records independently", () => {
  const objects = [{ id: "code", objectType: "software" }, { id: "paper", objectType: "paper" }, { id: "data", objectType: "dataset" }, { id: "claim", objectType: "claim" }];
  assert.deepEqual(filterResearchObjects(objects, "code").map((o) => o.id), ["code"]);
  assert.deepEqual(filterResearchObjects(objects, "papers").map((o) => o.id), ["paper"]);
  assert.deepEqual(filterResearchObjects(objects, "data").map((o) => o.id), ["data"]);
  assert.deepEqual(filterResearchObjects(objects, "other").map((o) => o.id), ["claim"]);
  assert.deepEqual(filterResearchObjects(objects, "all"), objects);
  assert.deepEqual(filterResearchObjects(objects, "unknown"), objects);
});
test("project search matches name or overview and preserves the source list", () => {
  const projects = [{ id: "one", title: "Hub Code", description: "再現実験" }, { id: "two", title: "論文", description: "Paper" }];
  assert.deepEqual(searchResearchProjects(projects, " CODE ").map((p) => p.id), ["one"]);
  assert.deepEqual(searchResearchProjects(projects, "再現").map((p) => p.id), ["one"]);
  assert.deepEqual(searchResearchProjects(projects, "paper").map((p) => p.id), ["two"]);
  assert.deepEqual(searchResearchProjects(projects, "none"), []);
  assert.deepEqual(searchResearchProjects(projects, ""), projects);
  assert.equal(projects.length, 2);
});

test('related contexts describe type uses and unknown kinds retain generic wording', () => {
  for (const [kind,label,description] of [
    ['article','記事','解説・報告を読む'],['video','動画','実演・講義を見る'],['thread','スレッド','質問・検証を続ける'],
    ['community','コミュニティ','継続して活動する'],['hubpedia','資料・知識','背景知識を確認する'],
  ]) assert.deepEqual(researchLinkContext(kind),{label,description});
  for (const kind of [undefined,null,0,[],{toString:'broken'},'unknown','constructor','toString','__proto__']) assert.deepEqual(researchLinkContext(kind),{label:'その他',description:'関連する情報を確認する'});
  researchLinkContext('article').label='changed';assert.equal(researchLinkContext('article').label,'記事');
});

test('related groups filter and restore without replacing link or unlink controls, and keep titles inert', async () => {
  const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),calls=[],state={};
  const links=[
    {kind:'article',targetId:'a',title:'<img src=x onerror=run()>',href:'/v2/articles/a'},
    {kind:'video',targetId:'v',title:'Video',href:'/v2/videos/v'},
    {kind:'thread',targetId:'t',title:'Thread',href:'/v2/threads/t'},
    {kind:'community',targetId:'c',title:'Community',href:'/v2/community?community=c'},
    {kind:'hubpedia',targetId:'knowledge',title:'Knowledge',href:'/v2/hubpedia/knowledge'},
    {targetId:'old',title:'Old fixture',href:'/v2/threads/old'},
    {kind:'unknown',targetId:'other',title:'Other fixture',href:'/v2/articles/other'},
  ];
  let opened,reloaded=0;
  const data={project:{id:'project'},canEdit:true,workspace:{documents:[],links}};
  const options={state,invoke:async(name,args)=>{if(name==='hub_detail'&&args.name==='research_pdfs')return{projectId:'project',pdfs:[],canEdit:true,signedIn:true};calls.push([name,args]);return{};},reload:async()=>{reloaded++;}};
  const render=()=>renderResearchProject(target,data,()=>{},path=>{opened=path;},null,options);
  render();assert.equal(target.querySelector('img'),null);assert.equal(target.querySelector('a').textContent,links[0].title);
  assert.deepEqual([...target.querySelectorAll('.research-related-purpose')].map(n=>n.textContent),['解説・報告を読む','実演・講義を見る','質問・検証を続ける','継続して活動する','背景知識を確認する','関連する情報を確認する']);
  const group=target.querySelector('[data-research-link-kind="thread"]'),anchor=group.querySelector('a'),remove=group.querySelector('button');
  target.querySelector('[data-research-link-group="thread"]').click();
  assert.deepEqual([...target.querySelectorAll('.research-related-group')].filter(n=>!n.hidden).map(n=>n.dataset.researchLinkKind),['thread']);
  assert.equal(group.querySelector('a'),anchor);assert.equal(group.querySelector('button'),remove);assert.equal(state.linkGroup,'thread');
  anchor.click();assert.equal(opened,'/v2/threads/t');assert.equal(calls.length,0);
  target.querySelector('[data-research-link-group="all"]').click();assert.equal([...target.querySelectorAll('.research-related-group')].filter(n=>!n.hidden).length,6);
  assert.equal(group.querySelector('button'),remove);
  await remove.onclick();assert.equal(reloaded,1);assert.deepEqual(calls[0],['hub_client_action',{action:'research_unlink',target:'project',options:{action:'unlink',kind:'thread',targetId:'t'}}]);
  target.querySelector('[data-research-link-group="thread"]').click();render();assert.equal(target.querySelector('[data-research-link-kind="thread"]').hidden,false);
  assert.equal(target.querySelector('[data-research-link-group="thread"]').getAttribute('aria-pressed'),'true');
  data.workspace.links=[links[0]];render();assert.equal(state.linkGroup,'all');assert.equal(target.querySelector('[data-research-link-kind="article"]').hidden,false);
  assert.equal(target.querySelector('[data-research-link-kind="video"]'),null);
  data.workspace.links=[];render();assert.match(target.textContent,/登録された関連先はありません。/);assert.equal(target.querySelector('.research-related-group'),null);
  dom.window.close();
});

test('registered and searched related links retain safe native destinations and reject dangerous paths', async () => {
  const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),opened=[];
  const unsafe=['javascript:run()','https://other.invalid/v2/articles/a','//other.invalid/v2/articles/a','/v2/articles/a/../../admin','/v2/articles/%2e%2e','/v2/articles/a%2fb','/v2/articles/a%5cb','/v2/articles/a%00b','/v2/articles/a%7fb','/v2/articles/a%broken','/v2/articles/a\\b','/v2/articles/a\n','/v2/articles/'+'x'.repeat(241),'/v2/community?community=a&community=b','/v2/community?community=..','/v2/market/products/a'];
  for (const href of unsafe) {
    renderResearchProject(target,{project:{id:'project'},workspace:{links:[{kind:'article',title:'Dangerous',href}]}},null,path=>opened.push(path));
    assert.equal(target.querySelector('a'),null,href);
  }
  const valid=['/v2/articles/a','/v2/articles/a%20b','/v2/articles/a%25b','/v2/articles/a%252fb','/v2/articles/'+'x'.repeat(240),'/v2/videos/v','/v2/threads/t','/v2/hubpedia/%E7%A0%94%E7%A9%B6','/v2/hubpedia/question%3Fmark','/v2/hubpedia/section%23mark','/v2/community?community=c&channel=ch','/v2/community/c'];
  renderResearchProject(target,{project:{id:'project'},workspace:{links:valid.map(href=>({title:href,href}))}},null,path=>opened.push(path));
  for (const anchor of target.querySelectorAll('a')) anchor.click();assert.deepEqual(opened,valid);
  const calls=[],data={project:{id:'project'},canEdit:true,workspace:{links:[]}};
  renderResearchProject(target,data,null,path=>opened.push(path),null,{invoke:async(name,args)=>{calls.push([name,args]);return name==='hub_detail'?[{kind:'article',targetId:'bad',title:'Dangerous',href:unsafe[0]},{kind:'article',targetId:'a',title:'Safe',href:valid[0]}]:{};}});
  const search=target.querySelector('.research-link-search');await search.onsubmit({preventDefault(){}});
  const rows=target.querySelectorAll('.research-link-row');rows[0].querySelector('button').click();assert.deepEqual(opened,valid);
  rows[1].querySelector('button').click();assert.equal(opened.at(-1),valid[0]);
  await rows[1].querySelector('button:last-child').onclick();assert.equal(calls.at(-1)[1].action,'research_link');assert.equal(calls.at(-1)[1].options.targetId,'a');
  const paste=[...target.querySelectorAll('form')].find(f=>f.elements.targetId);paste.elements.targetId.value='https://hub.jkamma.com/v2/articles/pasted';
  await paste.onsubmit({preventDefault(){}});assert.deepEqual(calls.at(-1)[1].options,{action:'link',kind:'article',targetId:'https://hub.jkamma.com/v2/articles/pasted'});
  dom.window.close();
});

test('the project sidebar is the research tree: プロジェクト / 探す, a project row opens that project and the column is not rebuilt', async () => {
  const {readFileSync} = await import('node:fs');
  const {nativeSidebarId} = await import('./native-sidebar.mjs');
  const {researchTreeModel, renderResearchTree} = await import('./research-tree.mjs');
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderSidebarContext(view) {');
  const end = source.indexOf(String.fromCharCode(10) + 'function showView(', start);
  assert.ok(start >= 0 && end > start);
  const opened = [];
  const renderSidebar = new Function('document', 'state', 'nativeSidebarId', 'opened', 'researchTreeModel', 'renderResearchTree', `
    const {messagesSide, messagesLayout, mailListCol, mailLayoutNode, sidebarContext, researchWorkspace} = state;
    const appendSidebarMine = () => {};
    let sidebarContextOwner = null, feedTreeNav = false, sidebarFeedTreeOwned = false; const FEED_TREE_VIEWS = new Set(), FEED_TREE_DETAILS = new Set();
    const MUSIC_TREE_DETAILS = new Set();
    const openDetail = (name, ids) => opened.push([name, ...ids]);
    const nativeSidebar = null, homeAccountEpoch = 0;
    const appsOpen = false, videoWatchIndex = -1, detailReturn = {view:"feed"}, currentView = "detail";
    const matchMedia = () => ({matches: true});
    let sidebarCollapsedForEmpty = false, sidebarEmptyView = false, sidebarCollapsedForRail = false;
    const createSidebarRemote = () => ({ state: () => ({ items: [] }), tags: () => [], load() {}, more() {} });
    const invoke = () => { throw new Error('unexpected'); }, desktopAccount = { state: 'anonymous' };
    const detailTrail = [{name:'research_project', ids:['p2']}];
    const DETAIL_PARENT_VIEW = {research_project:'research'};
    const DETAIL_SIDEBAR_FAMILY = {research_project:'research'};
    const readingDirectory = new Map();
    ${source.slice(start, end)}
    renderSidebarContext('detail');
  `);
  const dom = new JSDOM('<div class="app-shell"><div class="sidebar"><div class="brand"><h1></h1></div><div id="sidebar-context"></div></div><div id="messages-layout"><div id="messages-side"></div></div><main id="detail-content"></main></div>');
  const document = dom.window.document;
  const state = {
    messagesSide: document.querySelector('#messages-side'), messagesLayout: document.querySelector('#messages-layout'), mailListCol: document.createElement('div'), mailLayoutNode: document.createElement('div'),
    sidebarContext: document.querySelector('#sidebar-context'), researchWorkspace: {projects:()=>[{id:'p1',title:'第一の研究'},{id:'p2',title:'第二の研究'}]},
  };
  renderSidebar(document, state, nativeSidebarId, opened, researchTreeModel, renderResearchTree);
  const column = state.sidebarContext;
  assert.deepEqual([...column.querySelectorAll('.sidebar-tree-root')].map(node=>node.textContent),['プロジェクト','探す']);
  const rows = [...column.querySelectorAll('.sidebar-tree-children .sidebar-context-item')];
  assert.deepEqual(rows.map(node=>node.textContent),['第一の研究','第二の研究']);
  assert.equal(rows[1].classList.contains('on'),true,'the open project is the current row');
  assert.equal(rows[0].classList.contains('on'),false);
  const first = column.firstElementChild;
  rows[0].click();
  assert.deepEqual(opened.at(-1),['research_project','p1']);
  assert.equal(column.firstElementChild,first,'the column is not rebuilt');
  dom.window.close();
});

test('native Git management replaces its Web entry while PDF and history remain',()=>{const dom=new JSDOM('<main/>'),target=dom.window.document.querySelector('main'),opened=[];renderResearchProject(target,{project:{id:'project'},workspace:{documents:[],links:[]}},()=>{},()=>{},path=>opened.push(['web',path]),{openGit:id=>opened.push(['history',id]),openGitManagement:id=>opened.push(['management',id])});const buttons=[...target.querySelectorAll('button')];assert.equal(buttons.some(b=>b.textContent==='Gitの設定をWebで開く'||b.textContent==='GitリポジトリをWebで開く'),false);for(const title of ['論文PDFをWebで開く','Gitリポジトリの設定','変更履歴と差分を見る'])buttons.find(b=>b.textContent===title).click();assert.deepEqual(opened,[['web','/v2/research/project#pdfs'],['management','project'],['history','project']]);dom.window.close();});
test('history without native management preserves Git Web settings fallback',()=>{const dom=new JSDOM('<main/>'),target=dom.window.document.querySelector('main');let opened;renderResearchProject(target,{project:{id:'project'},workspace:{documents:[],links:[]}},()=>{},()=>{},path=>opened=path,{openGit:()=>{}});[...target.querySelectorAll('button')].find(b=>b.textContent==='Gitの設定をWebで開く').click();assert.equal(opened,'/v2/research/project#git');dom.window.close();});

test('fixed paper version opens only project code and returns to the same actor, source and revision state',t=>{
 const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main');t.after(()=>dom.window.close());const projectId='rp_'+'a'.repeat(32);
 const data={document:{id:'paper',projectId,title:'Paper',head:7},revision:{version:2,contentHash:'sha256:'+'a'.repeat(64),body:'Pinned v2 body',summary:'Fixed source'},history:[{version:2,summary:'Fixed source'},{version:7,summary:'Latest'}]};
 const scope={actor:'alice',source:'https://hub.example',generation:1},entry={name:'research_revision',ids:[projectId,'paper','2'],editorState:{paperDraft:'Retain unsent paper discussion'},scope},trail=[entry];let currentScope=scope;
 const options={state:entry.editorState,isCurrent:()=>trail.at(-1)===entry&&currentScope===scope,openGit:(...ids)=>trail.push({name:'research_git_history',ids,editorState:entry.editorState,scope:currentScope})};
 const control=renderResearchDocument(target,data,null,options),code=[...target.querySelectorAll('button')].find(n=>n.textContent==='このプロジェクトのコード');assert.ok(code);assert.equal(target.querySelector('pre').textContent,'Pinned v2 body');code.click();
 assert.deepEqual(trail.at(-1).ids,[projectId]);assert.equal(trail.at(-1).name,'research_git_history');assert.equal(trail.at(-1).scope,scope);assert.equal(trail.at(-1).editorState,entry.editorState);assert.equal(data.revision.version,2);code.onclick();assert.equal(trail.length,2);
 trail.pop();control.dispose();const restored=renderResearchDocument(target,data,null,options);assert.deepEqual(trail.at(-1).ids,[projectId,'paper','2']);assert.equal(target.querySelector('pre').textContent,'Pinned v2 body');assert.equal(target.querySelector('select').value,'2');assert.equal(entry.editorState.paperDraft,'Retain unsent paper discussion');
 const oldCode=[...target.querySelectorAll('button')].find(n=>n.textContent==='このプロジェクトのコード');for(const change of [{actor:'bob'},{source:'https://other.example'}]){currentScope={...scope,...change,generation:2};oldCode.onclick();assert.equal(trail.length,1);}currentScope=scope;restored.invalidate();oldCode.onclick();assert.equal(trail.length,1);
});

test('project code entry rejects malformed project IDs, stale roots and disposed readonly pages',t=>{
 const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main');t.after(()=>dom.window.close());let calls=0,current=true;const projectId='rp_'+'a'.repeat(32);
 const data=id=>({document:{id:'paper',projectId:id,title:'Paper'},revision:{version:2,body:'fixed'},history:[]});
 const options={isCurrent:()=>current,openGit:()=>calls++};
 for(const id of [undefined,null,0,'','project','rp_'+'a'.repeat(31),'rp_'+'a'.repeat(33),'rp_'+'A'.repeat(32),projectId+'\n',projectId+'\0','rp_'+'g'.repeat(32),'rp_../bad']){renderResearchDocument(target,data(id),null,options);assert.equal([...target.querySelectorAll('button')].some(n=>n.textContent==='このプロジェクトのコード'),false);}
 current=false;renderResearchDocument(target,data(projectId),null,options);assert.equal([...target.querySelectorAll('button')].some(n=>n.textContent==='このプロジェクトのコード'),false);current=true;
 const old=renderResearchDocument(target,data(projectId),null,options),oldButton=target.querySelector('button');renderResearchDocument(target,data('rp_'+'b'.repeat(32)),null,options);oldButton.onclick();assert.equal(calls,0);old.dispose();
 const latest=renderResearchDocument(target,data(projectId),null,options),button=target.querySelector('button');button.click();assert.equal(calls,1);latest.dispose();button.onclick();assert.equal(calls,1);
});
test('account and source events remove index rows, reject captured controls and cancel old debounce and responses',async t=>{
 for(const event of ['hub-account-changed','hub-origin-changed']){
  const f=researchIndexFixture(t),project={id:'rp_'+'a'.repeat(32),title:'Old project'};f.local=async()=>({projects:[project],hasMore:false});await f.view.load();const oldCard=f.document.querySelector('.research-project-card');assert.equal(oldCard.isConnected,true);oldCard.click();assert.deepEqual(f.opened,[project]);
  f.query.value='pending draft query';f.query.dispatchEvent(new f.dom.window.Event('input'));f.calls.length=0;f.dom.window.dispatchEvent(new f.dom.window.Event(event));oldCard.onclick();await new Promise(done=>setTimeout(done,280));assert.deepEqual(f.calls,[]);assert.deepEqual(f.opened,[project]);assert.deepEqual(f.view.projects(),[]);assert.equal(f.document.querySelector('main').children.length,0);assert.equal(f.document.querySelector('#research-state').textContent,'更新してプロジェクトを読み込んでください。');
  let resolveLocal,resolveRemote;f.local=()=>new Promise(done=>resolveLocal=done);f.remote=()=>new Promise(done=>resolveRemote=done);const pending=f.view.load();await new Promise(setImmediate);f.dom.window.dispatchEvent(new f.dom.window.Event(event));resolveLocal({projects:[project],hasMore:true});resolveRemote([{origin:'https://old.example',title:'Late old source'}]);await pending;assert.deepEqual(f.view.projects(),[]);assert.equal(f.document.querySelector('main').children.length,0);
 }
});

test('account and source events clear project creation input and refuse a late synthetic creation result',async t=>{
 for(const event of ['hub-account-changed','hub-origin-changed']){
  const f=researchIndexFixture(t),form=f.document.querySelector('.research-editor form');form.elements.title.value='Unsent new project';form.elements.title.dispatchEvent(new f.dom.window.Event('input'));f.document.querySelector('#research-create-web').click();let resolve;f.local=()=>new Promise(done=>resolve=done);const pending=form.onsubmit({preventDefault(){}});assert.equal(f.calls[0][0],'hub_client_action');f.dom.window.dispatchEvent(new f.dom.window.Event(event));resolve({project:{id:'rp_'+'b'.repeat(32),title:'Late old project'}});await pending;assert.equal(form.elements.title.value,'');assert.equal(form.closest('details').open,false);assert.deepEqual(f.opened,[]);
 }
});