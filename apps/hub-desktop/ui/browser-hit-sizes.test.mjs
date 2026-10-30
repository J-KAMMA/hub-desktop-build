import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
// Pins the minimum hit sizes of the in-app browser controls (2026-10-29, owner: "buttons too small, especially the tab x").
const read=name=>readFileSync(new URL('./'+name,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const tokens=read('shape-tokens.css'),polish=read('browser-polish.css'),rail=read('rail-browser.css'),styles=read('styles.css');
const px=name=>Number(new RegExp('--'+name+':\\s*(\\d+)px').exec(tokens)?.[1]);
const sized=(block,keys,token)=>{for(const key of keys)assert.ok(block.includes(`${key}: var(--${token});`),`${key} uses --${token}`);};
const comfort=polish.slice(polish.indexOf('押しやすさ（2026-10-29'));
test('shape tokens define the browser hit sizes',()=>{
 assert.ok(px('tap-height')>=36);assert.ok(px('tap-compact')>=32);assert.ok(px('tap-close')>=24&&px('tap-close')<=32);assert.ok(px('tap-close-glyph')>=14);
 assert.ok(px('tap-icon')>=18&&px('tap-icon')<=20);
});
test('tab close x: 28px circle, glyph at least 14px, visible on the active tab, hover and pressed backgrounds',()=>{
 const base=/\.browser-tab-close\{[^}]*\}/.exec(styles)[0];
 assert.ok(base.includes('width:var(--tap-close)')&&base.includes('height:var(--tap-close)')&&base.includes('font-size:var(--tap-close-glyph)')&&base.includes('border-radius:50%'));
 const block=/\.app-shell\.browser-active \.sidebar-tab > \.browser-tab-close \{[^}]*\}/.exec(polish)[0];
 sized(block,['width','height','min-width','min-height'],'tap-close');
 assert.ok(block.includes('border-radius: 50%;')&&block.includes('font-size: var(--tap-close-glyph);')&&block.includes('flex: 0 0 var(--tap-close);'));
 assert.match(polish,/\.sidebar-tab\.is-active > \.browser-tab-close,[^{]*\{ opacity: 1; \}/);
 assert.ok(polish.includes('.browser-tab-close:hover { background: var(--interactive-hover)'));
 assert.ok(polish.includes('.browser-tab-close:active { background:'));
 assert.ok(polish.includes('.browser-tab-close:focus-visible { outline: var(--focus-ring-width)'));
 assert.ok(styles.includes('#browser-mobile-tabs .browser-tab-close{width:var(--tap-close)}'));
});
test('title bar, address bar and strip buttons are at least 32px (36 in the title bar) with 20px icons',()=>{
 const toolbar=/#hub-shell \.app-toolbar \.toolbar-button,[^{]*\{[^}]*\}/.exec(polish)[0];
 sized(toolbar,['width','min-width','height','min-height'],'tap-height');
 assert.ok(polish.includes('.toolbar-button svg { width: var(--tap-icon); height: var(--tap-icon); }'));
 assert.ok(polish.includes('.toolbar-button:active:not(:disabled)')&&polish.includes('.toolbar-button:disabled { opacity: .4'));
 const strip=/:is\(\.browser-strip > button, #browser-protection\) \{\s*flex: 0 0 var\(--tap-height\);[^}]*\}/.exec(polish)[0];
 sized(strip,['width','min-width','height','min-height'],'tap-height');
 assert.ok(comfort.includes('#browser-form > :is(#browser-scheme, #browser-fav) { width: var(--tap-compact)')&&comfort.includes('height: var(--tap-compact)'));
 assert.ok(comfort.includes('#browser-fav svg { width: var(--tap-icon)'));
 assert.ok(comfort.includes('#sidebar-new-tab { width: var(--tap-compact)'));
});
test('right rail browser mini toolbar buttons are at least 32px with 20px icons',()=>{
 const last=rail.slice(rail.lastIndexOf('右列ブラウザの操作（2026-10-29）'));
 assert.ok(last.includes('.rb-button { width: var(--tap-compact); height: var(--tap-compact)')&&last.includes('.rb-button svg { width: var(--tap-icon)')&&last.includes('.rb-button:active'));
});
test('window controls and the drag region are not resized by the comfort rules',()=>{
 assert.equal(/window-control/.test(comfort),false);
 assert.equal(/app-region|drag/i.test(comfort),false);
});
