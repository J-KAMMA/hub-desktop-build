import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {FAVICON_MAX_BYTES,faviconImage,faviconSlot,validFavicon} from './browser-favicon.mjs';
import {createBrowserBookmarkBar} from './browser-bookmark-bar.mjs';
import {renderBrowserLibrary} from './browser-library.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const png='data:image/png;base64,'+Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('icon-body')]).toString('base64');
const big='data:image/png;base64,'+Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(FAVICON_MAX_BYTES)]).toString('base64');
const isBlob=v=>/^blob:/.test(v);
const doc=t=>{const dom=new JSDOM('<div id="bar"></div><section id="menu"></section>',{url:'http://localhost/'});t.after(()=>dom.window.close());return dom;};

test('only bounded PNG data URLs are accepted',()=>{
 assert.equal(validFavicon(png),true);
 for(const bad of [undefined,null,42,'','https://example.org/favicon.png','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,bm90IGEgcG5n','data:image/png;base64,iVBORw0KGgo!!!!','data:image/png;base64,iVBORw0KGgo=AAA',png+'"><script>',big,'data:image/png;base64,'+'A'.repeat(60000)])assert.equal(validFavicon(bad),false,String(bad).slice(0,40));
});

test('image and slot use img.src only for valid icons and never build HTML',t=>{
 const {document}=doc(t).window;
 const image=faviconImage(document,png);assert.ok(isBlob(image.src));assert.equal(image.alt,'');assert.equal(faviconImage(document,'<img src=x onerror=bad()>'),null);
 const slot=faviconSlot(document,{icon:png,url:'https://a.example/'});assert.ok(isBlob(slot.querySelector('img').src));assert.equal(slot.classList.contains('is-fallback'),false);
 const fallback=faviconSlot(document,{icon:'data:text/html,<script>',url:'https://www.example.org/'});assert.equal(fallback.querySelector('img'),null);assert.equal(fallback.dataset.letter,'E');assert.equal(fallback.textContent,'');
 assert.equal(faviconSlot(document,{}).dataset.letter,'◎');
});

test('bookmark bar shows the icon before the title, a fallback without one, and drops unusable icons',t=>{
 const {window}=doc(t),{document}=window,host=document.getElementById('bar');
 const bar=createBrowserBookmarkBar({document,window,host,open:async()=>{},manage:()=>{}});
 bar.update([{url:'https://a.example/',title:'A',folder:'',icon:png},{url:'https://b.example/',title:'B',folder:''},{url:'https://c.example/',title:'C',folder:'',icon:'javascript:alert(1)'}]);
 const items=[...host.querySelectorAll('.browser-bookmark-item')];
 assert.ok(isBlob(items[0].firstChild.querySelector('img').src));assert.equal(items[0].textContent,'A');
 for(const item of items.slice(1)){assert.equal(item.querySelector('img'),null);assert.ok(item.firstChild.classList.contains('is-fallback'));}
 assert.equal(items[1].textContent,'B');assert.equal(items[2].textContent,'C');
 bar.destroy();
});

test('library rows show the stored icon or a fallback',async t=>{
 const {window}=doc(t),{document}=window,host=document.getElementById('menu'),items=[{url:'https://a.example/',title:'A',folder:'',icon:png},{url:'https://b.example/',title:'B',folder:''}];
 const button=(label,action,className='')=>{const node=document.createElement('button');node.textContent=label;node.className=className;node.onclick=action;return node;};
 renderBrowserLibrary({document,window,host,items,button,invoke:async()=>items,refresh:async()=>{},report:()=>{},open:()=>{}});
 const rows=[...host.querySelectorAll('.browser-menu-row')];
 assert.ok(isBlob(rows[0].querySelector('.browser-menu-open img').src));assert.equal(rows[1].querySelector('img'),null);assert.equal(rows[1].querySelector('.browser-favicon').dataset.letter,'B');
});
