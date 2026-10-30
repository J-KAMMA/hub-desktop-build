import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
import {createBrowserBookmarkBar} from './browser-bookmark-bar.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom'),css=readFileSync(new URL('./browser-bookmark-bar.css',import.meta.url),'utf8');
const tick=()=>new Promise(setImmediate),entry=(name,folder='')=>({url:'https://'+name.toLowerCase()+'.example/',title:name,folder});
function fixture(t,width=700,storage){
 const dom=new JSDOM('<style>'+css+'</style><div id="bar"></div><button id="outside">outside</button>',{url:'http://fixture.invalid/',pretendToBeVisual:true}),document=dom.window.document;
 if(storage===undefined)dom.window.localStorage.setItem('hub.browser.bookmarkBar','1'); // shown by default since 2026-10-29; stored '1' keeps these tests explicit
 const f={dom,document,open:[],managed:0,active:true,errors:[]};
 f.controller=createBrowserBookmarkBar({document,window:dom.window,host:document.getElementById('bar'),open:async(item,destination)=>f.open.push({item,destination}),manage:()=>{f.managed++;},isCurrent:()=>f.active,report:error=>f.errors.push(error.message),storage});
 const row=document.querySelector('.browser-bookmark-row');Object.defineProperty(row,'clientWidth',{get:()=>width});
 dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return{width:this.classList.contains('browser-bookmark-more')?28:Math.min(160,Math.max(55,this.textContent.length*8+20))};};
 f.row=row;f.popup=document.querySelector('.browser-bookmark-popup');f.setWidth=value=>{width=value;f.controller.reflow();};
 f.update=value=>{f.controller.update(value);f.controller.reflow();};f.key=(node,key)=>node.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 t.after(()=>{f.controller.destroy();dom.window.close();});return f;
}
test('saved order and first folder appearance remain ordered; folder children preserve store order',t=>{
 const f=fixture(t);f.update([entry('A','研究'),entry('B'),entry('C','研究'),entry('D','__proto__')]);
 assert.deepEqual([...f.row.querySelectorAll('button:not([hidden])')].map(node=>node.textContent),['▸ 研究','B','▸ __proto__']);
 f.row.querySelector('.browser-bookmark-folder').click();assert.deepEqual([...f.popup.querySelectorAll('[data-bookmark-url]')].map(node=>node.textContent),['A','C']);
 assert.equal(f.popup.hidden,false);
});
test('normal/middle/Ctrl/Shift gestures route only existing page operations, right/Alt never open',async t=>{
 const f=fixture(t);f.update([entry('A')]);const item=f.row.querySelector('.browser-bookmark-item');
 for(const event of [{type:'click',button:0},{type:'auxclick',button:1},{type:'click',button:0,ctrlKey:true},{type:'click',button:0,shiftKey:true}])item.dispatchEvent(new f.dom.window.MouseEvent(event.type,{...event,bubbles:true,cancelable:true}));
 item.dispatchEvent(new f.dom.window.MouseEvent('auxclick',{button:2,bubbles:true}));item.dispatchEvent(new f.dom.window.MouseEvent('click',{button:0,altKey:true,bubbles:true}));await tick();
 assert.deepEqual(f.open.map(value=>value.destination),['current','background','background','foreground']);assert.ok(f.open.every(value=>value.item.url==='https://a.example/'));
});
test('JS URL, credentials, malformed Unicode, control title, huge URL and overflow library fail closed',async t=>{
 for(const value of [[{...entry('A'),url:'javascript:alert(1)'}],[{...entry('A'),url:'https://user:pass@example.test/'}],[{...entry('A'),title:'\ud800'}],[{...entry('A'),title:'bad\nname'}],[{...entry('A'),url:'https://example.test/'+('x'.repeat(4096))}],Array.from({length:1001},()=>entry('A'))]){
  const f=fixture(t);f.update([entry('Before')]);const old=f.row.querySelector('.browser-bookmark-item');assert.throws(()=>f.controller.update(value),/bookmark_bar_invalid/);old.click();await tick();assert.equal(f.open.length,0);assert.match(f.row.textContent,/確認できません/);
 }
});
test('literal titles never become HTML and long names have a complete accessible tooltip',t=>{
 const f=fixture(t),title='<img src="https://never.example/" onerror="bad()">'+('長い'.repeat(70));f.update([{...entry('A'),title}]);
 const item=f.row.querySelector('.browser-bookmark-item');assert.equal(item.textContent,title);assert.equal(f.document.querySelector('img'),null);assert.ok(item.title.startsWith(title));assert.equal(f.dom.window.getComputedStyle(item).textOverflow,'ellipsis');
});
test('overflow has one More entry and expands only hidden saved groups; resizing restores order',t=>{
 const f=fixture(t,220);f.update([entry('LongNameA'),entry('LongNameB'),entry('C','フォルダ'),entry('D')]);
 const more=f.row.querySelector('.browser-bookmark-more');assert.equal(more.hidden,false);assert.equal(f.row.querySelectorAll('button:not([hidden])').length,2);more.click();
 assert.equal(f.popup.hidden,false);assert.ok(f.popup.textContent.includes('LongNameB'));assert.ok(f.popup.textContent.includes('フォルダ'));assert.equal(f.popup.textContent.includes('LongNameA'),false);
 f.setWidth(900);assert.equal(more.hidden,true);assert.equal(f.row.querySelectorAll('button:not([hidden])').length,4);
});
test('keyboard arrows, Home/End and Escape keep popup and toolbar focus usable',t=>{
 const f=fixture(t);f.update([entry('A'),entry('B','Folder'),entry('C')]);const items=[...f.row.querySelectorAll('button:not([hidden])')];items[0].focus();f.key(items[0],'ArrowRight');assert.equal(f.document.activeElement,items[1]);
 items[1].click();const popupItems=[...f.popup.querySelectorAll('button')];assert.equal(f.document.activeElement,popupItems[0]);f.key(popupItems[0],'End');assert.equal(f.document.activeElement,popupItems.at(-1));f.key(popupItems.at(-1),'Escape');assert.equal(f.popup.hidden,true);assert.equal(f.document.activeElement,items[1]);
});
test('unchanged refresh preserves keyboard focus and popup while metadata edits/moves update the bar',t=>{
 const f=fixture(t),saved=[entry('A'),entry('B','Folder')];f.update(saved);const folder=f.row.querySelector('.browser-bookmark-folder');folder.click();const focus=f.document.activeElement;
 f.update(structuredClone(saved));assert.equal(f.popup.hidden,false);assert.equal(f.document.activeElement,focus);
 f.update([entry('Renamed','Folder'),entry('A')]);assert.equal(f.popup.hidden,true);assert.deepEqual([...f.row.querySelectorAll('button:not([hidden])')].map(node=>node.textContent),['▸ Folder','A']);
});
test('toggle persistence uses only the Hub key; late old rows, off-view and disposal cannot open',async t=>{
 const calls=[],storage={getItem:key=>{calls.push(['get',key]);return'0';},setItem:(key,value)=>calls.push(['set',key,value])};const f=fixture(t,700,storage);
 assert.equal(f.controller.isVisible(),false);f.controller.toggle();f.update([entry('A')]);const old=f.row.querySelector('.browser-bookmark-item');f.update([entry('B')]);old.click();f.active=false;f.row.querySelector('.browser-bookmark-item').click();await tick();assert.equal(f.open.length,0);
 f.active=true;f.controller.destroy();old.click();await tick();assert.equal(f.open.length,0);assert.ok(calls.every(value=>value[1]==='hub.browser.bookmarkBar'));
});
test('management delegates to existing library and storage errors never claim saved success',t=>{
 const f=fixture(t,700,{getItem:()=>'1',setItem:()=>{throw Error('quota');}});f.row.querySelector('.browser-bookmark-empty').click();assert.equal(f.managed,1);
 f.controller.toggle();assert.deepEqual(f.errors,['browser_preference_unavailable']);assert.equal(f.controller.isVisible(),false);
});


test('bar is shown by default, a stored 0 hides it, and its buttons keep comfortable hit sizes (2026-10-29)',t=>{
 const memory=value=>({getItem:()=>value,setItem(){}});
 assert.equal(fixture(t,700,memory(null)).controller.isVisible(),true);
 assert.equal(fixture(t,700,memory('1')).controller.isVisible(),true);
 const hidden=fixture(t,700,memory('0'));assert.equal(hidden.controller.isVisible(),false);assert.equal(hidden.document.getElementById('bar').hidden,true);
 assert.match(css,/\.browser-bookmark-bar button \{[^}]*height:var\(--tap-compact\)/);
 assert.match(css,/browser-bookmark-more \{ width:var\(--tap-compact\)/);
 assert.match(css,/browser-bookmark-row \{[^}]*height:calc\(var\(--tap-compact\) \+ 4px\)/);
});
