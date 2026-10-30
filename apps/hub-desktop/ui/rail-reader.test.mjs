import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {createRailReader} from './rail-reader.mjs';
test('rail reading preserves the center, ignores old responses and navigates only explicitly',async()=>{
  const dom=new JSDOM('<main>draft</main><aside><button id="a">A</button><button id="b">B</button></aside>'),d=dom.window.document;let resolve,opened;
  const reader=createRailReader({document:d,read:async detail=>detail.name==='old'?new Promise(r=>{resolve=r;}):{article:{body:'<script>unsafe()</script>'}},open:item=>{opened=item;}});
  const first=reader.show('search',d.querySelector('#a'),{title:'old',detail:{name:'old'}});
  await reader.show('search',d.querySelector('#b'),{title:'new',detail:{name:'new'}});resolve({article:{body:'stale'}});await first;
  assert.equal(d.querySelector('main').textContent,'draft');assert.match(d.querySelector('.rail-reader-body').textContent,/unsafe/);assert.equal(d.querySelector('script'),null);assert.equal(opened,undefined);
  d.querySelector('.rail-post-preview-actions button').click();assert.equal(opened.title,'new');reader.clear();assert.equal(d.querySelector('.rail-post-preview'),null);dom.window.close();
});
