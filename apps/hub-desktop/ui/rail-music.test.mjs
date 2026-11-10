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
 const engine={track:null,queue:[],paused:true,currentTime:0,duration:0};const engineListeners=new Set();
 const notifyEngine=()=>{for(const f of engineListeners)f();};
 ctl.engine=engine;ctl.notifyEngine=notifyEngine;
 const nav=createRailNav();
 const deps={
  getTracks:()=>tracks,getWorks:()=>[ytWork],isHubOriginalWork:w=>String(w.id).startsWith('music:'),empty:()=>document.createElement('p'),
  loadCatalog:async query=>{calls.push(['search',query]);return{tracks:[track('bbbbbbbb-bbbb-4bbb-8bbb-000000000001','Found','Q','')],works:[ytWork]};},
  playTrack:(...args)=>{calls.push(['play',...args]);return true;},
  player:{state:()=>({...engine,hasPrev:engine.queue.indexOf(engine.track)>0,hasNext:engine.track!==null&&engine.queue.indexOf(engine.track)<engine.queue.length-1}),subscribe:f=>{engineListeners.add(f);return()=>engineListeners.delete(f);},toggle:()=>calls.push(['toggle']),prev:()=>calls.push(['prev']),next:()=>calls.push(['next']),seek:s=>calls.push(['seek',s])},enqueue:x=>calls.push(['enqueue',x]),
  youtube:{play:(work,panel)=>{calls.push(['yt',work.id,panel.id]);ytPlaying=work.id;panel.hidden=false;for(const f of ytListeners)f();return true;},stop:()=>{ytPlaying=null;for(const f of ytListeners)f();},isPlaying:id=>ytPlaying===id,active:()=>ytPlaying,subscribe:f=>{ytListeners.add(f);return()=>ytListeners.delete(f);}},
  nav:{visit:route=>nav.visit('music','k'+(++seq),{route})},
  posts:({host,work})=>{calls.push(['posts',work.id]);const node=document.createElement('section');node.className='video-posts';host.append(node);return{destroy(){calls.push(['posts-destroy'])}};},
  report:({host,work,open})=>{calls.push(['report',work.id,open]);return null;},
  download:work=>({allowed:work.downloadPolicy==='anyone',open:()=>calls.push(['download',work.id])}),
  openExternal:url=>calls.push(['external',url]),
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
test('tapping a Hub track plays it through the shared engine in place; the row has a ⋯ menu button, not a detail page',t=>{
 const f=fixture(t);f.rail.showList();
 f.host.querySelector('.rail-music-item .rail-item').click();
 const play=f.calls.find(c=>c[0]==='play');assert.ok(play);assert.equal(play[1].title,'Hub 0');assert.ok(play[2].length>=12);
 assert.equal(f.host.querySelector('.rail-music-work'),null,'no page opens');
 const more=f.host.querySelector('.rail-music-item .music-more');assert.ok(more);
 assert.equal(more.hubMusicWork.id,'music:'+f.tracks[0].id);
 assert.deepEqual(f.central,[]);
});
test('tapping a YouTube row plays it in the rail frame and stays on the list; the card follows and can close it',t=>{
 const f=fixture(t);f.rail.showList();
 const row=[...f.host.querySelectorAll('.rail-music-item')].find(item=>item.textContent.includes('Outside'));
 row.querySelector('.rail-item').click();
 assert.deepEqual(f.calls.find(c=>c[0]==='yt'),['yt','yt-1','rail-music-yt']);
 assert.equal(f.yt.hidden,false);
 assert.equal(f.host.querySelector('.rail-music-work'),null,'stays on the list');
 assert.ok(f.host.querySelector('.rail-player.is-video'));
 assert.equal(f.host.querySelector('.rp-title').textContent,'Outside');
 assert.ok([...f.host.querySelectorAll('.rail-music-item')].find(item=>item.textContent.includes('Outside')).classList.contains('is-current'));
 assert.ok(row.querySelector('.music-more'),'the row keeps its ⋯ menu');
 f.host.querySelector('.rp-play').click();
 assert.equal(f.host.querySelector('.rail-player.is-video'),null);
 assert.deepEqual(f.central,[]);
});
test('the now-playing card is idle with the first track, then follows the shared engine live',t=>{
 const f=fixture(t);f.rail.showList();
 const card=f.host.querySelector('.rail-player');assert.ok(card.classList.contains('is-idle'));assert.equal(card.querySelector('.rp-title').textContent,'Hub 0');
 assert.ok(card.querySelector('.rp-play svg'),'svg icon, not a glyph');
 card.querySelector('.rp-play').click();
 const play=f.calls.find(c=>c[0]==='play');assert.equal(play[1].title,'Hub 0');
 const queue=f.tracks.slice(0,3).map(x=>({...x}));
 Object.assign(f.ctl.engine,{track:queue[1],queue,paused:false,currentTime:30,duration:120});f.ctl.notifyEngine();
 assert.equal(card.querySelector('.rp-title').textContent,'Hub 1');
 assert.equal(card.querySelector('.rp-cur').textContent,'0:30');assert.equal(card.querySelector('.rp-dur').textContent,'2:00');
 assert.equal(card.querySelector('.rp-bar').value,'30');
 assert.equal(card.querySelector('.rp-play').getAttribute('aria-label'),'一時停止');
 assert.deepEqual([...f.host.querySelectorAll('.rail-music-next .rail-item-head strong')].map(n=>n.textContent),['Hub 2']);
 assert.ok(f.host.querySelector('.rail-music-next h3').textContent==='次に再生');
 assert.ok([...f.host.querySelectorAll('.rail-music-item.is-current')].some(r=>r.dataset.key==='t:'+queue[1].id));
 card.querySelector('.rp-play').click();assert.equal(f.calls.at(-1)[0],'toggle');
 const [prev,,next,qbtn]=card.querySelectorAll('.rp-btn');
 prev.click();assert.equal(f.calls.at(-1)[0],'prev');next.click();assert.equal(f.calls.at(-1)[0],'next');
 const bar=card.querySelector('.rp-bar');bar.value='60';bar.dispatchEvent(new f.dom.window.Event('change'));assert.deepEqual(f.calls.at(-1),['seek',60]);
 qbtn.click();assert.equal(f.host.querySelector('.rail-music-next').hidden,true,'queue toggle hides the next-up section');
 card.querySelector('.rp-artist').click();assert.deepEqual(f.calls.find(c=>c[0]==='collection'),['collection','artist','H','']);
});
test('leaving the list stops listening to the shared engine',t=>{
 const f=fixture(t);f.rail.showList();f.rail.show({type:'artist',name:'H'});
 const before=f.calls.length;f.ctl.notifyEngine();assert.equal(f.calls.length,before);
 assert.equal(f.host.querySelector('.rail-player'),null);
});
test('a Hub work in the rail shows its license, the download notice and the posts; leaving disposes the posts',t=>{
 const f=fixture(t);
 f.rail.show({type:'work',work:{id:HUB,title:'HW',artist:'A',license:'cc-by-sa-4.0',downloadPolicy:'anyone'}});
 assert.match(f.host.querySelector('.rail-music-license').textContent,/ライセンス：CC BY-SA 4\.0/);
 f.host.querySelector('.rail-music-license button').click();
 assert.deepEqual(f.calls.at(-1),['external','https://creativecommons.org/licenses/by-sa/4.0/deed.ja']);
 [...f.host.querySelectorAll('.rail-music-chip')].find(n=>/ダウンロード/.test(n.textContent)).click();
 assert.deepEqual(f.calls.at(-1),['download',HUB]);
 f.rail.show({type:'work',work:{id:'plain',title:'No license',license:'arr'},report:true});
 assert.equal(f.host.querySelector('.rail-music-license'),null);
 assert.ok(f.calls.some(c=>c[0]==='posts-destroy'));
 assert.deepEqual(f.calls.filter(c=>c[0]==='report').at(-1),['report','plain',true]);
});
test('artist and album links drill down in the rail and use the rail history for back and forward',async t=>{
 const f=fixture(t);f.rail.showList();
 {const route={type:'work',work:{id:HUB,title:'HW',artist:'H',album:'Album H'}};f.nav.visit('music','w0',{route});f.rail.show(route);}
 [...f.host.querySelectorAll('.rail-music-link')].find(n=>n.textContent==='H').click();
 assert.deepEqual(f.calls.find(c=>c[0]==='collection'),['collection','artist','H','']);
 assert.equal(f.host.textContent.includes('artist:H'),true);
 f.ctl.collectionActions.openAlbum('Album H','H');
 assert.deepEqual(f.calls.filter(c=>c[0]==='collection').at(-1),['collection','album','Album H','H']);
 assert.equal(f.nav.can('music',-1),true);
 await f.nav.back('music');assert.ok(f.host.textContent.includes('artist:H'));
 await f.nav.back('music');await f.nav.back('music');assert.ok(f.host.querySelector('.rail-music-quick'),'back reaches the list');
 await f.nav.forward('music');await f.nav.forward('music');assert.ok(f.host.textContent.includes('artist:H'));
 assert.ok(f.calls.some(c=>c[0]==='collection-destroy'));
 assert.deepEqual(f.central,[]);
});
test('the collection actions play, queue and open works without leaving the rail',t=>{
 const f=fixture(t);f.rail.show({type:'artist',name:'H'});
 const start={id:'a1',title:'T'};f.ctl.collectionActions.playTracks([start,{id:'a2',title:'U'}],start);
 assert.equal(f.calls.at(-1)[0],'play');
 f.ctl.collectionActions.enqueue(start);assert.equal(f.calls.at(-1)[0],'enqueue');
 f.ctl.collectionActions.playWork(ytWork);assert.ok(f.host.querySelector('.rail-music-work'));
 assert.deepEqual(f.calls.find(c=>c[0]==='yt'),['yt','yt-1','rail-music-yt']);
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

test('one row per track: title, muted artist and a 32px ghost ⋯ button on the right',t=>{
 const f=fixture(t);f.rail.showList();
 const items=[...f.host.querySelectorAll('.rail-music-item')];
 assert.ok(items.length>=10);
 for(const item of items){
  assert.equal(item.querySelectorAll('.rail-item').length,1,'a single row per track');
  assert.equal(item.querySelector('.rail-music-links'),null,'no second artist row');
  assert.equal(item.querySelectorAll('.rail-music-link').length,0,'no 詳細 text link');
  const detail=item.querySelector('button.rail-music-detail');
  assert.ok(detail&&detail.classList.contains('btn-icon')&&detail.classList.contains('btn-ghost'));
  assert.ok('musicMenu' in detail.dataset);
  assert.equal(detail.textContent,'⋯');
  assert.match(detail.getAttribute('aria-label'),/のその他の操作/);
 }
 const first=items[0];
 assert.equal(first.querySelector('.rail-item-head strong').textContent,'Hub 0');
 assert.equal(first.querySelector('.rail-item-text').textContent,'H');
 assert.deepEqual(f.central,[]);
});
test('the details button is 32px, ghost, and only shows on hover or focus',()=>{
 const css=readFileSync(new URL('rail-music.css',root),'utf8');
 assert.match(css,/\.rail-music-item \.rail-music-detail \{[^}]*width: 32px; height: 32px;[^}]*border: 0;[^}]*background: transparent;[^}]*opacity: 0;/);
 assert.match(css,/\.rail-music-item:hover \.rail-music-detail, \.rail-music-item:focus-within \.rail-music-detail[^{]*\{ opacity: 1; \}/);
});
