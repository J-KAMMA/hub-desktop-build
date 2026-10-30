import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {initMusicQueueView} from './music-queue-view.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
function fixture(t){
  const dom=new JSDOM('<button id="toggle" aria-controls="queue">再生待ち</button><section id="queue" hidden></section>');t.after(()=>dom.window.close());
  const f={document:dom.window.document,state:{queue:[{id:'a',title:'現在の曲'},{id:'b',title:'次の曲'}],currentId:'a',currentIndex:0},played:[],removed:[]};
  f.host=f.document.querySelector('#queue');f.toggle=f.document.querySelector('#toggle');
  f.control=initMusicQueueView({document:f.document,host:f.host,toggle:f.toggle,getState:()=>f.state,onPlay:track=>f.played.push(track.id),onRemove:id=>f.removed.push(id)});return f;
}
test('queue opens with current marker, jumps without backend writes and removes upcoming only',async t=>{
  const f=fixture(t);f.toggle.click();assert.equal(f.host.hidden,false);assert.equal(f.toggle.getAttribute('aria-expanded'),'true');
  assert.equal(f.host.querySelector('[aria-current="true"]').textContent.includes('現在の曲'),true);
  await f.host.querySelector('[aria-label="次の曲を再生"]').onclick();await f.host.querySelector('[aria-label="次の曲を再生待ちから除去"]').onclick();
  assert.deepEqual(f.played,['b']);assert.deepEqual(f.removed,['b']);assert.equal(f.host.querySelector('[aria-label="現在の曲を再生待ちから除去"]'),null);
  f.host.querySelector('button').click();assert.equal(f.host.hidden,true);assert.equal(f.document.activeElement,f.toggle);
});
test('old rows and disposed queue never act on a later queue even when the same ID exists',async t=>{
  const f=fixture(t);f.toggle.click();const old=f.host.querySelector('[aria-label="次の曲を再生"]');
  f.state.queue=[{id:'b',title:'次の曲'},{id:'a',title:'現在の曲'}];await old.onclick();assert.deepEqual(f.played,[]);
  f.control.render();const later=f.host.querySelector('[aria-label="次の曲を再生"]');f.control.destroy();await later.onclick();assert.deepEqual(f.played,[]);
});
test('escape restores focus and empty queues show a usable state',t=>{
  const f=fixture(t);f.toggle.click();f.host.querySelector('button').focus();f.host.dispatchEvent(new f.document.defaultView.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(f.host.hidden,true);assert.equal(f.toggle.getAttribute('aria-expanded'),'false');
  f.state={queue:[],currentId:null,currentIndex:-1};f.control.render();assert.equal(f.toggle.disabled,true);assert.match(f.host.textContent,/再生待ちは空/);
});
