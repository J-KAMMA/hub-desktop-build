import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import * as railPanels from './rail-panels.mjs';
import {createRailMusic} from './rail-music.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const root=new URL('./',import.meta.url);
const app=readFileSync(new URL('app.js',root),'utf8').replaceAll('\r\n','\n');
function actual(signature){const start=app.indexOf(signature),end=app.indexOf('\n}',start);assert.ok(start>=0&&end>start,signature);return app.slice(start,end+2);}
function fixture(t){
 const dom=new JSDOM(readFileSync(new URL('index.html',root),'utf8'),{url:'https://synthetic-shell.invalid/'}),document=dom.window.document,calls=[],selections=[];
 const shell=document.querySelector('.app-shell');shell.classList.add('rail-open');
 const ctx=vm.createContext({document,desktopShell:shell,railChat:{sync(){}},startupTool:null,currentView:'feed',railPreferredView:'search',railView:'search',RAIL_VIEW_KEY:'hub.desktop.railView.v2',RAIL_VIEWS:['browser','posts','search','notifications','messages','music','video','wallet','ai'],MAIN_RAIL_VIEWS:{feed:'posts'},railVideo:{show(){},release(){}},RAIL_VIEW_NAMES:{browser:'ブラウザ',posts:'タイムライン',search:'資料・検索',notifications:'通知',messages:'メッセージ',music:'音楽',video:'動画',wallet:'ウォレット',ai:'AI'},railMessagesTab:'dm',railPostsTab:'posts',RAIL_POSTS_TAB_KEY:'rail-posts-tab',loadRail:name=>calls.push(['load',name]),
  localStorage:{setItem:(...args)=>calls.push(['save',...args])},saveRailChoice:open=>calls.push(['openChoice',open]),setDesktopRailOpen:open=>{shell.classList.toggle('rail-open',open);ctx.syncRailView();},
  requestAnimationFrame:fn=>fn(),railSearchQuery:document.querySelector('#rail-search-query'),refreshRailActivity:()=>calls.push(['read']),
  updatePiWorkEmptyState(){},paintRailNav(){},syncRailMarkAll(){},legacyPiWorkController:false,matchMedia:()=>({matches:false}),
  musicPlayer:{queue:[{id:'track',title:'Keep this song',artist:'Artist'}],currentId:'track',tracks:[]},musicAudio:{paused:false},railMusicWorks:[],
  railReader:{show:(...args)=>selections.push(args)},openDetail:(...args)=>calls.push(['central',...args]),playMusicTrack:(...args)=>calls.push(['play',...args]),railMusicEmpty:()=>document.createElement('p'),
  relTime:()=>'',railPanels,
 });
 ctx.musicQueue={adjacentMusicQueueTrack:(queue,id,step)=>queue[queue.findIndex(item=>item.id===id)+step]??null};ctx.toggleMusicPlayback=()=>calls.push(['toggle']);ctx.railMusicTracks=[];
 ctx.railMusic=createRailMusic({document,host:document.querySelector('#rail-music'),ytHost:document.querySelector('#rail-music-yt'),deps:{getTracks:()=>ctx.railMusicTracks,getWorks:()=>ctx.railMusicWorks,isHubOriginalWork:work=>ctx.isHubOriginalWork(work),empty:()=>document.createElement('p'),loadCatalog:async()=>({tracks:[],works:[]}),playTrack:(...args)=>calls.push(['play',...args]),enqueue:()=>{},youtube:{play:()=>true,stop(){},isPlaying:()=>false,subscribe:()=>()=>{}},nav:{visit:()=>{}},collection:()=>null,library:()=>null,playlists:()=>null}});
 ctx.isHubOriginalWork=work=>typeof work?.id==='string'&&work.id.startsWith('music:');
 // The strip buttons are bound by this exact loop in app.js (not re-implemented here).
 const binding=app.slice(app.lastIndexOf('for (const button of document.querySelectorAll(".rail-view-button")) {'),app.indexOf('\n}',app.indexOf('button.onclick = () => onRailViewButton(')) +2);
 assert.ok(binding.includes('onRailViewButton(button.dataset.railView)'),'strip binding block found');
 vm.runInContext(['function paintRailMessagesTabs() {','function placeRailAiWorkspace() {','function syncRailView() {','function selectRailView(name) {','function onRailViewButton(name) {','function renderRailNowPlaying() {','function railMusicRow(item, onOpen) {','function renderRailMusic() {','function railRow(title, text, at, onOpen) {','function railLoadError(text, retry, showPublicPosts = false) {'].map(actual).join('\n')+'\n'+binding,ctx);
 t.after(()=>dom.window.close());return{dom,document,ctx,calls,selections};
}
test('the far-right strip is the only switcher: toggle first, then every destination with a name tooltip',t=>{
 const {document}=fixture(t);
 const marks=[...document.querySelectorAll('.rail-marks > button')];
 assert.equal(marks[0].id,'rail-activity-toggle');
 const buttons=[...document.querySelectorAll('.rail-marks .rail-view-button')];
 assert.deepEqual(buttons.map(item=>item.dataset.railView),['notifications','messages','posts','music','video','browser','ai','wallet']);
 assert.deepEqual(buttons.map(item=>item.title),['通知','メッセージ','タイムライン','音楽','動画','ブラウザ','AI','ウォレット']);
 assert.equal(document.querySelector('#rail-view-title').tagName,'H2');assert.equal(document.querySelector('.rail-activity-head select'),null);
});
test('strip buttons mark the current view with aria-pressed and the heading names it',t=>{
 const {document,ctx}=fixture(t);
 ctx.selectRailView('music');
 const pressed=[...document.querySelectorAll('.rail-view-button[aria-pressed="true"]')].map(item=>item.dataset.railView);
 assert.deepEqual(pressed,['music']);assert.equal(document.querySelector('#rail-view-title').textContent,'音楽');
 ctx.selectRailView('posts');
 assert.deepEqual([...document.querySelectorAll('.rail-view-button[aria-pressed="true"]')].map(item=>item.dataset.railView),['posts']);
 assert.equal(document.querySelector('#rail-view-title').textContent,'タイムライン');
});
test('a strip click opens a collapsed rail on that view; clicking the current view again keeps it open (only the toggle closes)',t=>{
 const {document,ctx,calls}=fixture(t);
 document.querySelector('.app-shell').classList.remove('rail-open');
 ctx.onRailViewButton('messages');
 assert.ok(document.querySelector('.app-shell').classList.contains('rail-open'));assert.equal(ctx.railView,'messages');
 calls.length=0;
 ctx.onRailViewButton('music');assert.equal(ctx.railView,'music');assert.ok(document.querySelector('.app-shell').classList.contains('rail-open'));
 calls.length=0;ctx.onRailViewButton('music');
 assert.ok(document.querySelector('.app-shell').classList.contains('rail-open'),'pressing the shown view again keeps the rail open');
 assert.ok(!calls.some(c=>c[0]==='openChoice'&&c[1]===false));assert.equal(ctx.railPreferredView,'music');
 assert.deepEqual([...document.querySelectorAll('.rail-view-button[aria-pressed="true"]')].map(item=>item.dataset.railView),['music']);
});
test('real strip click handlers: every button shows exactly its own [data-rail-view] section, from any starting view and from the default 音楽',t=>{
 const {document,ctx}=fixture(t);
 const visible=()=>[...document.querySelectorAll('section.rail-view')].filter(s=>!s.hidden).map(s=>s.dataset.railView);
 const names=[...document.querySelectorAll('.rail-marks .rail-view-button')].map(b=>b.dataset.railView);
 assert.deepEqual(names.slice().sort(),['ai','browser','messages','music','notifications','posts','video','wallet']);
 ctx.railPreferredView='music';ctx.syncRailView();assert.deepEqual(visible(),['music'],'default view is the music panel');
 for(const from of ['music','browser',null])for(const name of names){
  if(from)document.querySelector(`.rail-marks .rail-view-button[data-rail-view="${from}"]`).click();
  document.querySelector('.app-shell').classList.add('rail-open');
  document.querySelector(`.rail-marks .rail-view-button[data-rail-view="${name}"]`).click();
  assert.deepEqual(visible(),[name],`${from} -> ${name}`);assert.equal(ctx.railView,name);
  assert.ok(document.querySelector('.app-shell').classList.contains('rail-open'),name);
  assert.equal(document.querySelector('#rail-view-title').textContent,ctx.RAIL_VIEW_NAMES[name]);
  assert.deepEqual([...document.querySelectorAll('.rail-view-button[aria-pressed="true"]')].map(b=>b.dataset.railView),[name]);
 }
 // a collapsed rail (the default below 1180px) opens on a strip click, on the music panel
 document.querySelector('.app-shell').classList.remove('rail-open');ctx.railPreferredView='music';ctx.syncRailView();
 document.querySelector('.rail-marks .rail-view-button[data-rail-view="music"]').click();
 assert.ok(document.querySelector('.app-shell').classList.contains('rail-open'));assert.deepEqual(visible(),['music']);
 assert.ok(document.querySelector('[data-rail-view="music"].rail-view #rail-music'),'the music section holds the music list');
});
test('the stored rail view is validated and the default is 音楽',t=>{
 const source=app.slice(app.indexOf('let railPreferredView = "music";'),app.indexOf('} catch {}',app.indexOf('let railPreferredView = "music";'))+10);
 assert.ok(source.includes('hub.desktop.railOpen'));
 const run=stored=>{const c=vm.createContext({RAIL_VIEWS:['browser','posts','search','notifications','messages','music','wallet','ai'],RAIL_VIEW_KEY:'k',localStorage:{getItem:key=>key==='k'?stored:null},railUserChoice:true,browserRailChoice:false});
  vm.runInContext(source.replace(/^let /gm,'var '),c);return c.railView+'/'+c.railPreferredView;};
 assert.equal(run(null),'music/music');assert.equal(run('evil'),'music/music');assert.equal(run('browser'),'browser/browser');assert.equal(run('community'),'music/music');
});
test('the right music panel lists now playing, the queue, Hub Music, then YouTube Music',t=>{
 const {document,ctx,calls}=fixture(t);
 ctx.musicPlayer.queue=[{id:'a',title:'Now',artist:'X'},{id:'b',title:'Next one',artist:'Y'},{id:'c',title:'After',artist:'Z'}];ctx.musicPlayer.currentId='a';
 ctx.railMusicTracks=[{id:'t1',title:'Hub track',artist:'H'}];
 ctx.railMusicWorks=[{id:'yt-1',title:'Outside',artist:'O'},{id:'music:11111111-1111-4111-8111-111111111111',title:'Hub work',artist:'W'}];
 ctx.renderRailMusic();
 const playing=[...document.querySelectorAll('#rail-playing strong, #rail-playing h3, #rail-playing .rail-item-head strong')].map(n=>n.textContent);
 assert.deepEqual(playing,['Now','再生待ち · 2曲','Next one','After']);
 [...document.querySelectorAll('#rail-playing .rail-item')][0].click();assert.equal(calls.at(-1)[0],'play');assert.equal(calls.at(-1)[1].id,'b');
 const list=[...document.querySelectorAll('#rail-music h3, #rail-music .rail-item-head strong')].map(n=>n.textContent);
 assert.deepEqual(list,['Hub Music','Hub track','Hub work','YouTube Music','Outside']);
});
test('switching central pages and side tools preserves side query and the same AI draft DOM',t=>{
 const {document,ctx}=fixture(t);const workspace=document.querySelector('#ai-workspace');
 const input=document.createElement('textarea');input.value='Unsent draft';workspace.append(input);
 document.querySelector('#rail-search-query').value='Independent research';
 ctx.selectRailView('ai');assert.equal(workspace.parentElement.id,'rail-ai-workspace-host');
 ctx.currentView='videos';ctx.syncRailView();assert.equal(ctx.railView,'ai');assert.equal(workspace.parentElement.id,'rail-ai-workspace-host');
 ctx.selectRailView('music');assert.equal(input.value,'Unsent draft');
 ctx.selectRailView('search');assert.equal(document.querySelector('#rail-search-query').value,'Independent research');
 assert.equal(ctx.currentView,'videos');
 ctx.selectRailView('ai');assert.equal(workspace.querySelector('textarea'),input);
});
test('the single AI workspace moves to central AI and returns without duplicate runs or draft loss',t=>{
 const {document,ctx}=fixture(t);const workspace=document.querySelector('#ai-workspace');
 ctx.selectRailView('ai');ctx.currentView='ai';ctx.syncRailView();
 assert.equal(ctx.railView,'search');assert.equal(workspace.parentElement.id,'view-ai');
  assert.ok(document.querySelector('.rail-view-button[data-rail-view="ai"]').disabled);
 ctx.currentView='feed';ctx.syncRailView();assert.equal(ctx.railView,'ai');assert.equal(workspace.parentElement.id,'rail-ai-workspace-host');
 assert.equal(document.querySelectorAll('#ai-workspace').length,1);
});
test('legacy destinations and empty-state alternatives remain reachable without duplicated rail icons',t=>{
 const {document,ctx}=fixture(t);
 for(const name of ['posts','notifications']){ctx.selectRailView(name);assert.equal(ctx.railView,name);assert.equal(document.querySelector('#rail-view-title').textContent,ctx.RAIL_VIEW_NAMES[name]);assert.equal(document.querySelector(`[data-rail-view="${name}"].rail-view`).hidden,false);assert.equal(ctx.currentView,'feed');}
 ctx.currentView='videos';const error=ctx.railLoadError('Unavailable',()=>{},true);error.querySelectorAll('button')[1].click();assert.equal(ctx.railView,'posts');
});
test('the right rail has no separate community button; the timeline view carries groups as one of its kinds',t=>{
 const {document}=fixture(t);
 assert.equal(document.querySelector('.rail-view-button[data-rail-view="community"]'),null);
 assert.equal(document.querySelector('section.rail-view[data-rail-view="community"]'),null);
 const posts=document.querySelector('section.rail-view[data-rail-view="posts"]');
 assert.ok(posts.querySelector('#rail-timeline'),'timeline mount');
 assert.equal(posts.querySelector('[data-rail-posts-tab]'),null,'the old two-tab strip is gone');
 assert.equal(posts.querySelector('#rail-communities'),null);
});
test('unknown rail inputs do not change selection or write preferences',t=>{
 const {ctx,calls}=fixture(t);ctx.selectRailView('evil');assert.equal(ctx.railPreferredView,'search');assert.deepEqual(calls,[]);
});
test('right playback buttons drive the shared engine directly and never touch the central player or view',t=>{
 const {document,ctx,calls}=fixture(t);
 for(const id of ['music-prev','music-toggle','music-next'])document.getElementById(id).onclick=()=>calls.push(['central-control',id]);
 ctx.musicPlayer.queue=[{id:'a',title:'A'},{id:'b',title:'B'}];ctx.musicPlayer.currentId='b';
 ctx.renderRailNowPlaying();const buttons=document.querySelectorAll('#rail-playing .rail-playback-controls button');
 assert.ok(buttons[2].disabled);assert.ok(!buttons[0].disabled);
 buttons[0].click();buttons[1].click();
 assert.deepEqual(calls.map(c=>c[0]),['play','toggle']);assert.equal(calls[0][1].id,'a');
 assert.ok(!calls.some(c=>c[0]==='central-control'||c[0]==='central'));assert.equal(ctx.currentView,'feed');
});
test('a work row in the right music panel drills down inside the rail instead of opening a central preview',t=>{
 const {document,ctx,calls}=fixture(t);ctx.railMusicWorks=[{id:'work',title:'Work',artist:'Author',description:'Description'}];
 ctx.renderRailMusic();document.querySelector('#rail-music .rail-item').click();
 assert.ok(document.querySelector('#rail-music .rail-music-work'));assert.deepEqual(calls.filter(c=>c[0]==='central'),[]);assert.equal(ctx.currentView,'feed');
});
test('the wallet strip button selects the wallet section, which holds the compact wallet host',t=>{
 const {document,ctx}=fixture(t);
 const button=document.querySelector('.rail-marks .rail-view-button[data-rail-view="wallet"]');
 assert.ok(button,'wallet button is on the far-right strip');
 button.click();
 assert.equal(ctx.railView,'wallet');
 assert.equal(document.querySelector('#rail-view-title').textContent,'ウォレット');
 const visible=[...document.querySelectorAll('section.rail-view')].filter(section=>!section.hidden).map(section=>section.dataset.railView);
 assert.deepEqual(visible,['wallet']);
 assert.ok(document.querySelector('[data-rail-view="wallet"].rail-view #rail-wallet'));
 assert.deepEqual([...document.querySelectorAll('.rail-view-button[aria-pressed="true"]')].map(item=>item.dataset.railView),['wallet']);
});
