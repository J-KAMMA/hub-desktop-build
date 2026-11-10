import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {inspectLink,leaveFacts} from './link-safety.mjs';
import {detectBait} from './bait-warning.mjs';
import {renderUserText} from './outbound-link.mjs';

const corpus=JSON.parse(readFileSync(new URL('../../hub/lib/bait-warning-corpus.json',import.meta.url),'utf8'));

test('copies match the web source of truth',()=>{
  for(const name of ['link-safety.mjs','bait-warning.mjs']){
    assert.equal(readFileSync(new URL(`./${name}`,import.meta.url),'utf8'),readFileSync(new URL(`../../hub/lib/${name}`,import.meta.url),'utf8'),name);
  }
});

test('bait corpus: every positive flagged, no negative flagged',()=>{
  for(const p of corpus.positive)assert.ok(detectBait(p.text).kinds.includes(p.kind),p.text);
  for(const n of corpus.negative)assert.equal(detectBait(n).flagged,false,n);
});

test('lookalike and punycode facts',()=>{
  const info=inspectLink('https://xn--mtamask-s1a.io/');
  assert.equal(info.idn,true);
  assert.ok(leaveFacts(info).facts.some(f=>f.includes('xn--mtamask-s1a.io')));
  assert.equal(inspectLink('https://jkarnma.com/').lookalike.kind,'hub');
  assert.equal(inspectLink('https://metamask.io/').lookalike,null);
});

test('renderUserText gates external links, opens internal ones directly, adds the warning row',()=>{
  const dom=new JSDOM('');const doc=dom.window.document;const opened=[];
  const open=(href,meta)=>opened.push([href,meta?.internal]);
  const node=renderUserText(doc,'見て https://evil.example/a と https://hub.jkamma.com/x',{open});
  doc.body.append(node);
  const [ext,int]=node.querySelectorAll('a');
  ext.click();
  assert.equal(opened.length,0);
  assert.ok(node.querySelector('.outbound-link__panel').textContent.includes('evil.example'));
  node.querySelector('.outbound-link__open').click();
  assert.deepEqual(opened,[['https://evil.example/a',false]]);
  int.click();
  assert.deepEqual(opened[1],['https://hub.jkamma.com/x',true]);
  const flagged=renderUserText(doc,'シードフレーズを教えてください。',{open});
  assert.ok(flagged.querySelector('.bait-warning'));
  assert.ok(flagged.querySelector('p').textContent.includes('シードフレーズ'));
  assert.equal(renderUserText(doc,'こんにちは。いい天気です。',{open}).querySelector('.bait-warning'),null);
});

test('confirmLeave and addBaitRow',async()=>{
  const {confirmLeave,addBaitRow}=await import('./outbound-link.mjs');
  const dom=new JSDOM('<p><a id="a" href="#">x</a></p>');const doc=dom.window.document;const opened=[];
  const a=doc.querySelector('#a');
  confirmLeave(doc,a,'https://hub.jkamma.com/x',{open:h=>opened.push(h)});
  assert.deepEqual(opened,['https://hub.jkamma.com/x']);
  confirmLeave(doc,a,'https://jkarnma.com/',{open:h=>opened.push(h)});
  assert.equal(opened.length,1);
  assert.ok(doc.querySelector('.outbound-link__warning'));
  confirmLeave(doc,a,'https://jkarnma.com/',{open:h=>opened.push(h)});
  assert.equal(doc.querySelector('.outbound-link__panel'),null);
  const p=doc.createElement('p');doc.body.append(p);
  assert.equal(addBaitRow(doc,p,'こんにちは'),null);
  assert.ok(addBaitRow(doc,p,'秘密鍵を送ってください'));
  addBaitRow(doc,p,'秘密鍵を送ってください');
  assert.equal(doc.querySelectorAll('.bait-warning').length,1);
});
