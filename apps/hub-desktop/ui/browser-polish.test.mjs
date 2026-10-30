import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {initBrowserPanels} from './browser-panels.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const read=name=>readFileSync(new URL(`./${name}`,import.meta.url),'utf8');
const css=read('browser-polish.css').replace(/\/\*[\s\S]*?\*\//g,'');
const tick=()=>new Promise(setImmediate);

test('browser-polish.css loads after every other desktop stylesheet and uses tokens only',()=>{
  const index=read('index.html'),at=name=>index.indexOf(`./${name}`);
  for(const earlier of ['browser-ui.css','browser-vertical-tabs.css','hub-design.css','desktop-shell.css','desktop-media.css','rail-browser.css','byok.css'])assert.ok(at('browser-polish.css')>at(earlier),earlier);
  assert.doesNotMatch(css,/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|(?<![-\w])white(?![-\w])|(?<![-\w])black(?![-\w])/);
  // Focus is a neutral line or surface change, never a coloured glow.
  assert.doesNotMatch(css,/var\(--action[^)]*\)[^;{}]*;/);
  assert.doesNotMatch(css,/box-shadow:[^;]*var\(--(?:action|accent|focus-ring)/);
});

test('every action stays a 32px square with an 18px glyph; the tab strip uses a 16px favicon and a surface, not a colour, for the active tab',()=>{
  assert.match(css,/\.browser-tab-badge\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px/);
  assert.match(css,/\.sidebar-tab\.is-active[^{]*\{[^}]*background:\s*var\(--selected\);[^}]*box-shadow:\s*var\(--elevation-1\)/);
  assert.match(css,/browser-tabs-horizontal #browser-tabbar\s*\{[^}]*height:\s*40px/);
  assert.match(css,/\.sidebar-tab\s*\{[^}]*flex:\s*0 1 220px;[^}]*min-width:\s*120px/);
  assert.match(css,/#browser-protection\)\s*svg\s*\{\s*width:\s*18px;\s*height:\s*18px/);
});

test('the site identity button shows a lock, a warning triangle or a controls glyph, never a bare "i"',()=>{
  const source=read('browser-workspace.mjs');
  assert.doesNotMatch(source,/\?\s*'<svg[^']*'\s*:\s*'i'\s*;/);
  for(const state of ['secure','insecure','none'])assert.match(source,new RegExp(`${state}:\\s*'<`));
  assert.match(source,/dataset\.state = schemeState/);
  assert.match(css,/#browser-scheme\[data-state="insecure"\]\s*\{[^}]*var\(--warning-text\)/);
});

test('the closed-tab restore action lives in the ≡ menu and the narrow-desktop column hides its text button',()=>{
  const source=read('browser-workspace.mjs');
  assert.match(source,/item\('restore', '閉じたタブを復元', 'Ctrl\+Shift\+T'/);
  assert.match(css,/@media \(min-width: 721px\)\s*\{[^}]*#browser-restore\s*\{\s*display:\s*none/);
});

test('the protection button reports on, off or unknown for styling',()=>{
  assert.match(read('browser-protection-ui.mjs'),/button\.dataset\.state=usable\?\(state\.enabled\?'on':'off'\):'unknown'/);
  assert.match(css,/#browser-protection\[data-state="on"\]/);
  assert.match(css,/#browser-protection\[data-state="off"\]/);
});

test('the download button is an icon with a count badge for running downloads only',async()=>{
  const dom=new JSDOM('<div><section id="browser-menu" hidden></section><div id="browser-tools"></div></div>',{url:'http://localhost'}),document=dom.window.document;
  let rows=[];
  dom.window.__TAURI__={event:{listen:()=>{}}};
  const button=(text,run,className='')=>{const node=document.createElement('button');node.type='button';node.className=className;node.textContent=text;node.onclick=run;return node;};
  const invoke=async name=>name==='browser_session_status'?0:name==='browser_downloads'?rows:name==='browser_site_requests'?[]:undefined;
  const panels=initBrowserPanels({document,window:dom.window,invoke,button,report:()=>{},refresh:async()=>{},hideSuggestions:()=>{}});await tick();
  const trigger=document.querySelector('#browser-downloads'),badge=()=>trigger.querySelector('.browser-download-badge');
  assert.ok(trigger.querySelector('svg'));assert.equal(trigger.textContent,'');assert.equal(badge().hidden,true);assert.equal(trigger.getAttribute('aria-label'),'ダウンロード');
  const row=status=>({id:1,name:'a.zip',received:1,total:2,status,path:null,canResume:false,choosingDestination:false,interruptReason:null});
  rows=[row('active'),{...row('active'),id:2}];await panels.load();
  assert.equal(badge().hidden,false);assert.equal(badge().textContent,'2');assert.match(trigger.getAttribute('aria-label'),/進行中 2 件/);
  rows=[row('complete')];await panels.load();assert.equal(badge().hidden,true);assert.equal(trigger.getAttribute('aria-label'),'ダウンロード');
});

test('sleeping tabs stay recognisable in the collapsed column and the audio toggle stays visible',()=>{
  assert.match(css,/\.sidebar-tab\.is-discarded \.browser-tab-select > \.browser-tab-badge::after \{ content: "休";/);
  assert.match(css,/\.browser-tab-sleeping \{ color: var\(--text\);/);
  assert.match(css,/\.sidebar-tab > \.browser-tab-audio \{ display: grid;/);
  assert.doesNotMatch(css,/\.browser-tab-audio[^{]*\{[^}]*opacity:\s*0[;\s}]/);
});
