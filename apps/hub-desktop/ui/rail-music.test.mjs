import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createRailMusic, railTrackOf} from './rail-music.mjs';
import {createRailNav} from './rail-nav.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const root=new URL('./',import.meta.url);
const HUB='music:11111111-1111-4111-8111-111111111111';
const track=(id,title,artist,album)=>({id,title,artist,album});
const ytWork={id:'yt-1',title:'Outside',artist:'Out Artist',services:[{provider:'youtube',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}]};

// 中央の画面へ移る関数は deps に渡さない。窓に仕込んだ同名の関数が呼ばれたら central に残る。
function fixture(t,extra={}){
 const dom=new JSDOM('<div id="rail-music"></div><div id="rail-music-yt" hidden></div>',{url:'https://synthetic-shell.invalid/'}),document=dom.window.document;
 const calls=[],central=[];
 const tracks=Array.from({length:12},(_,i)=>track('aaaaaaaa-aaaa-4aaa-8aaa-'+String(i).padStart(12,'0'),'Hub '+i,'H','Album H'));
 let ytPlaying=null;const ytListeners=new Set();
 const ctl={};let seq=0;
 const nav=createRailNav();
 const deps={
  getTracks:()=>tracks,getWorks:()=>[ytWork],isHubOriginalWork:w=>String(w.id).startsWith('music:'),empty:()=>document.createElement('p'),
  loadCatalog:async query=>{calls.push(['search',query]);return{tracks:[track('bbbbbbbb-bbbb-4bbb-8bbb-000000000001','Found','Q','')],works:[ytWork]};},
  playTrack:(...args)=>{calls.push(['play',...args]);return true;},enqueue:x=>calls.push(['enqueue',x]),
  youtube:{play:(work,panel)=>{calls.push(['yt',work.id,panel.id]);ytPlaying=work.id;panel.hidden=false;for(const f of ytListeners)f();return true;},stop:()=>{ytPlaying=null;for(const f of ytListeners)f();},isPlaying:id=>ytPlaying===id,subscribe:f=>{ytListeners.add(f);return()=>ytListeners.delete(f);}},
  nav:{visit:route=>nav.visit('music','k'+(++seq),{route})},
  collection:({host,kind,name,artist,actions})=>{calls.push(['collection',kind,name,artist]);host.textContent=kind+':'+name;ctl.collectionActions=actions;return{destroy(){calls.push(['collection-destroy'])}};},
  library:({host,actions})=>{calls.push(['library']);host.textContent='library';ctl.libraryActions=actions;return null;},
  playlists:({host,actions})=>{calls.push(['playlists']);host.textContent='playlists';ctl.playlistActions=actions;return null;},
  ...extra,
 };
 const rail=createRailMusic({document,host:document.querySelector('#rail-music'),ytHost:document.querySelector('#rail-music-yt'),deps});
 nav.handle('music',entry=>{rail.show(entry.key==='list'?{type:'list'}:entry.data.route);return true;});
 for(const name of ['openDetail','setView','showView','navigate','enterBrowser','navigateFrom'])dom.window[name]=(...a)=>central.push([name,...a]);
 t.after(()=>dom.window.close());
 const flush=()=>new Promise(r=>setTimeout(r,0));
 return{dom,document,host:document.querySelector('#rail-music'),calls,central,nav,rail,ctl,flush,tracks,yt:document.querySelector('#rail-music-yt')};
}
const titles=host=>[...host.querySelectorAll('.rail-item-head strong, h3')].map(n=>n.textContent);

test('the list shows Hub Music then YouTube Music inside the rail, with a search box and library chips',t=>{
 const f=fixture(t);f.rail.showList();
 assert.ok(f.host.querySelector('form[role="search"]'));
 assert.deepEqual([...f.host.querySelectorAll('.rail-music-chip')].map(n=>n.textContent),['お気に入り','プレイリスト']);
 assert.deepEqual(titles(f.host).filter(x=>x==='Hub Music'||x==='YouTube Music'||x==='Outside'),['Hub Music','YouTube Music','Outside']);
 assert.deepEqual(f.central,[]);
});
test('search runs in the rail: results are listed in the rail and the search is a rail history entry',async t=>{
 const f=fixture(t);f.rail.showList();
 f.host.querySelector('.rail-music-query').value='abc';
 f.host.querySelector('form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));
 await f.flush();
 assert.deepEqual(f.calls.find(c=>c[0]==='search'),['search','abc']);
 assert.ok(titles(f.host).includes('Found'));assert.ok(titles(f.host).includes('Outside'));
 assert.ok(f.nav.can('music',-1),'rail back is enabled');
 await f.nav.back('music');assert.equal(f.host.querySelector('.rail-music-results'),null);assert.ok(f.host.querySelector('.rail-music-quick'));
 assert.deepEqual(f.central,[]);
});
test('tapping a Hub track plays it through the shared engine and stays in the rail',t=>{
 const f=fixture(t);f.rail.showList();
 f.host.querySelector('.rail-music-item .rail-item').click();
 const play=f.calls.find(c=>c[0]==='play');assert.ok(play);assert.equal(play[1].title,'Hub 0');assert.ok(play[2].length>=12);
 f.host.querySelector('.rail-music-item .rail-music-link:last-child').click();
 assert.equal(f.calls.at(-1)[0],'enqueue');
 assert.deepEqual(f.central,[]);
});
test('artist and album links drill down in the rail and use the rail history for back and forward',async t=>{
 const f=fixture(t);f.rail.showList();
 [...f.host.querySelectorAll('.rail-music-link')].find(n=>n.textContent==='H').click();
 assert.deepEqual(f.calls.find(c=>c[0]==='collection'),['collection','artist','H','']);
 assert.equal(f.host.textContent.includes('artist:H'),true);
 f.ctl.collectionActions.openAlbum('Album H','H');
 assert.deepEqual(f.calls.filter(c=>c[0]==='collection').at(-1),['collection','album','Album H','H']);
 assert.equal(f.nav.can('music',-1),true);
 await f.nav.back('music');assert.ok(f.host.textContent.includes('artist:H'));
 await f.nav.back('music');assert.ok(f.host.querySelector('.rail-music-quick'),'back reaches the list');
 await f.nav.forward('music');assert.ok(f.host.textContent.includes('artist:H'));
 assert.ok(f.calls.some(c=>c[0]==='collection-destroy'));
 assert.deepEqual(f.central,[]);
});
test('the collection actions play, queue and open works without leaving the rail',t=>{
 const f=fixture(t);f.rail.show({type:'artist',name:'H'});
 const start={id:'a1',title:'T'};f.ctl.collectionActions.playTracks([start,{id:'a2',title:'U'}],start);
 assert.equal(f.calls.at(-1)[0],'play');
 f.ctl.collectionActions.enqueue(start);assert.equal(f.calls.at(-1)[0],'enqueue');
 f.ctl.collectionActions.openWork(ytWork);assert.ok(f.host.querySelector('.rail-music-work'));
 f.ctl.collectionActions.playWork(ytWork);
 assert.deepEqual(f.calls.at(-1),['yt','yt-1','rail-music-yt']);
 assert.deepEqual(f.central,[]);
});
test('すべて見る opens the full list as a rail drill-down',async t=>{
 const f=fixture(t);f.rail.showList();
 const more=f.host.querySelector('.rail-music-more');assert.ok(more);more.click();
 assert.equal(f.host.querySelectorAll('.rail-music-item').length,12);
 assert.ok(f.nav.can('music',-1));await f.nav.back('music');assert.equal(f.host.querySelectorAll('.rail-music-item').length,11);
 assert.deepEqual(f.central,[]);
});
test('お気に入り and プレイリスト open as rail pages and route their actions into the rail',t=>{
 const f=fixture(t);f.rail.showList();
 const [fav]=f.host.querySelectorAll('.rail-music-chip');
 fav.click();assert.ok(f.calls.some(c=>c[0]==='library'));
 f.ctl.libraryActions.play({id:HUB,title:'F'},[{id:HUB,title:'F'}]);
 assert.equal(f.calls.at(-1)[1].id,HUB.slice(6));
 f.ctl.libraryActions.open(ytWork);assert.ok(f.host.querySelector('.rail-music-work'));
 f.rail.show({type:'list'});f.host.querySelectorAll('.rail-music-chip')[1].click();
 assert.ok(f.calls.some(c=>c[0]==='playlists'));
 f.ctl.playlistActions.open(ytWork);assert.ok(f.host.querySelector('.rail-music-work'));
 assert.deepEqual(f.central,[]);
});
test('a YouTube work plays in the rail slot, not in the central view, and can be closed there',t=>{
 const f=fixture(t);f.rail.show({type:'work',work:ytWork});
 const play=f.host.querySelector('.rail-music-chip.is-primary');assert.match(play.textContent,/YouTube/);play.click();
 assert.deepEqual(f.calls.at(-1),['yt','yt-1','rail-music-yt']);
 assert.equal(f.yt.hidden,false);
 assert.match(f.host.querySelector('.rail-music-work-actions button').textContent,/閉じる/);
 f.host.querySelector('.rail-music-work-actions button').click();
 assert.match(f.host.querySelector('.rail-music-work-actions button').textContent,/再生/);
 assert.deepEqual(f.central,[]);
});
test('a Hub work page plays in the rail; works with no embeddable source show a note and no external links',t=>{
 const f=fixture(t);f.rail.show({type:'work',work:{id:HUB,title:'HW',artist:'A'}});
 f.host.querySelector('.rail-music-chip.is-primary').click();
 assert.equal(f.calls.at(-1)[1].id,HUB.slice(6));
 f.rail.show({type:'work',work:{id:'other',title:'No source',services:[{provider:'spotify',url:'https://open.spotify.com/track/1'}]}});
 assert.match(f.host.querySelector('.rail-music-status').textContent,/再生できる提供元がありません/);
 assert.equal(f.host.querySelector('a'),null);
});
test('refresh does not disturb a drill-down; showList resets to the list',t=>{
 const f=fixture(t);f.rail.show({type:'artist',name:'H'});f.rail.refresh();
 assert.ok(f.host.textContent.includes('artist:H'));f.rail.showList();assert.ok(f.host.querySelector('.rail-music-quick'));
});
test('railTrackOf only converts Hub music ids',()=>{assert.equal(railTrackOf({id:HUB,title:'x'}).id,HUB.slice(6));assert.equal(railTrackOf({id:'yt-1'}),null);});

// 静的な保証：右列の音楽は中央の画面を切り替える関数を持たず、呼ばない。
const FORBIDDEN=/\b(openDetail|setView|showView|navigateFrom|navigate|enterBrowser|openMusicArtist|openMusicAlbum|openMusicSideMode|selectView|activateView)\s*\(/;
test('rail-music.mjs never references main-view navigation',()=>{
 const source=readFileSync(new URL('rail-music.mjs',root),'utf8').split('\n').filter(l=>!l.trim().startsWith('//')).join('\n');
 assert.doesNotMatch(source,FORBIDDEN);
 assert.doesNotMatch(source,/\.click\(\)/);
 assert.doesNotMatch(source,/querySelector\(['"]#(music-|view-|detail)/);
 assert.doesNotMatch(source,/\bimport\b[^\n]*app\.js/);
});
function block(app,signature){const start=app.indexOf(signature),end=app.indexOf('\n}\n',start);assert.ok(start>=0&&end>start,signature);return app.slice(start,end+3);}
test('the rail music wiring in app.js (initRailMusic, now playing, rail nav handler) calls no main-view navigation',()=>{
 const app=readFileSync(new URL('app.js',root),'utf8').replaceAll('\r\n','\n');
 const wiring=block(app,'function initRailMusic() {')+block(app,'function renderRailNowPlaying() {')+block(app,'function renderRailMusic() {');
 assert.doesNotMatch(wiring,FORBIDDEN);
 assert.doesNotMatch(wiring,/\.click\(\)/);
 assert.doesNotMatch(wiring,/#music-(prev|next|toggle|query|tab)/);
 const at=app.indexOf('railNav.handle("music"');
 const handler=app.slice(at,app.indexOf('\n',at));
 assert.doesNotMatch(handler,FORBIDDEN);assert.match(handler,/railMusic\?\.show/);
 const from=app.indexOf('if (name === "music") {');
 const music=app.slice(from,app.indexOf('if (name === "messages") {',from));
 assert.doesNotMatch(music,/musicPlayer\.tracks\s*=|renderMusicTracks\(/);
});
test('rail music CSS lives in its own file and uses tokens only',()=>{
 const css=readFileSync(new URL('rail-music.css',root),'utf8');
 assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black)\s*[;}]/i);
 assert.doesNotMatch(css,/(font-size|border-radius)\s*:\s*\d+px/);
 assert.match(readFileSync(new URL('index.html',root),'utf8'),/rail-music\.css/);
});
