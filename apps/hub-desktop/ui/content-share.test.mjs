import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createContentShare, attachContentShare } from './content-share.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, withReference = false) {
  const dom = new JSDOM('<div id="detail"></div><form><textarea></textarea><select><option>followers</option></select><img src="blob:synthetic"></form>', { url: 'http://fixture.invalid' });
  t.after(() => dom.window.close());
  const document = dom.window.document, host = document.querySelector('form'), textarea = document.querySelector('textarea');
  const f = { dom, document, host, textarea, detail: document.querySelector('#detail'), source: true, destination: false,
    scope: { origin: 'https://hub.invalid', key: 'device-a-key-a', epoch: {} }, reads: 0, navigations: 0, changed: 0, inputs: 0, opened: [] };
  f.getContext = async () => { f.reads++; return f.scope; };
  f.navigate = async () => { f.navigations++; f.source = false; f.destination = true; };
  textarea.value = '元の草稿\n'; textarea.addEventListener('input', () => f.inputs++);
  f.controller = createContentShare({ document, host, textarea, getContext: () => f.getContext(), isCurrent: () => f.destination,
    onNavigate: () => f.navigate(), onChanged: () => f.changed++,
    onOpenReference: withReference ? (...args) => f.openReference(...args) : undefined });
  f.openReference = (href, isCurrent, event) => { f.opened.push({href, isCurrent, event}); };
  f.offer = (href = '/v2/articles/article-a', title = '<img src=x onerror=attack>') => f.controller.offer({ href, title, isCurrent: () => f.source });
  f.add = () => [...f.controller.element.querySelectorAll('button')].find(button => button.textContent === '紹介リンクを追加');
  return f;
}

test('preview returns to the exact public source without editing the live draft, attachments or audience', async t => {
  const oid = 'a'.repeat(64);
  for (const href of ['/v2/articles/article-a', '/v2/videos/video-a', '/v2/music/works/track-a',
    '/v2/research/rp_a?document=paper&version=7', `https://github.com/owner/repo/commit/${oid}`,
    'https://another.invalid/v2/articles/article-a']) {
    const f = fixture(t, true), image = f.host.querySelector('img'); assert.equal(await f.offer(href), true);
    f.textarea.value = '編集中の草稿'; const event = new f.dom.window.MouseEvent('click');
    const open = [...f.controller.element.querySelectorAll('button')].find(button => button.textContent === '元の対象を開く');
    assert.equal(open.hidden, false); assert.equal(await open.onclick(event), true);
    assert.equal(f.opened.length, 1); assert.equal(f.opened[0].href, new URL(href, f.scope.origin).href);
    assert.equal(f.opened[0].event, event); assert.equal(f.opened[0].isCurrent(), true);
    assert.equal(f.textarea.value, '編集中の草稿'); assert.equal(f.host.querySelector('img'), image);
    assert.equal(f.host.querySelector('select').value, 'followers'); assert.equal(f.inputs, 0); assert.equal(f.changed, 0);
    f.destination = false; assert.equal(f.opened[0].isCurrent(), false);
  }
});

test('late source opening rejects actor, origin, epoch and detached preview changes', async t => {
  for (const change of [f => { f.scope = {...f.scope, key:'other actor'}; }, f => { f.scope = {...f.scope, origin:'https://other.invalid'}; },
    f => { f.scope = {...f.scope, epoch:{}}; }, f => f.controller.invalidate(), f => f.host.remove()]) {
    const f = fixture(t, true); assert.equal(await f.offer(), true); const wait = deferred(); f.getContext = () => wait.promise;
    const open = [...f.controller.element.querySelectorAll('button')].find(button => button.textContent === '元の対象を開く');
    const work = open.onclick(); change(f); wait.resolve(f.scope); assert.equal(await work, false);
    assert.equal(f.opened.length, 0); assert.equal(f.textarea.value, '元の草稿\n'); assert.equal(f.inputs, 0);
  }
});

test('opening is single-flight, rejects a superseded callback and leaves text edits intact', async t => {
  const f = fixture(t, true); assert.equal(await f.offer(), true); const wait = deferred(); let calls = 0;
  f.getContext = () => { calls++; return wait.promise; };
  const open = [...f.controller.element.querySelectorAll('button')].find(button => button.textContent === '元の対象を開く');
  const work = open.onclick(); assert.equal(await open.onclick(), false); assert.equal(await f.add().onclick(), false);
  f.textarea.value = '確認中に編集'; wait.resolve(f.scope); assert.equal(await work, true); assert.equal(calls, 1);
  assert.equal(f.textarea.value, '確認中に編集'); assert.equal(f.opened[0].isCurrent(), true);
  f.controller.invalidate(); assert.equal(f.opened[0].isCurrent(), false);
});

test('missing callback, Promise-valued destination and failed opening never authorize navigation or expose errors', async t => {
  const absent = fixture(t); assert.equal(await absent.offer(), true);
  assert.equal([...absent.controller.element.querySelectorAll('button')].find(button => button.textContent === '元の対象を開く').hidden, true);
  const f = fixture(t, true); assert.equal(await f.offer(), true);
  const open = [...f.controller.element.querySelectorAll('button')].find(button => button.textContent === '元の対象を開く');
  f.destination = Promise.resolve(true); assert.equal(await open.onclick(), false); assert.equal(f.opened.length, 0);
  f.destination = true; f.openReference = () => { throw Error('private-error-value'); };
  assert.equal(await open.onclick(), false); assert.match(f.controller.element.textContent, /草稿は保持/);
  assert.equal(f.controller.element.textContent.includes('private-error-value'), false); assert.equal(f.textarea.value, '元の草稿\n');
});

test('no eager reads or post: article preview preserves draft/image/audience and adds only after explicit click', async t => {
  const f = fixture(t), image = f.host.querySelector('img');
  assert.equal(f.reads, 0); assert.equal(await f.offer(), true); assert.equal(f.navigations, 1);
  assert.equal(f.textarea.value, '元の草稿\n'); assert.equal(f.changed, 0); assert.equal(f.host.querySelector('img'), image);
  assert.equal(f.host.querySelector('select').value, 'followers'); assert.equal(f.controller.element.querySelector('img'), null);
  f.textarea.value = '最新の草稿';
  assert.equal(await f.add().onclick(), true); assert.equal(f.textarea.value, '最新の草稿\n\nhttps://hub.invalid/v2/articles/article-a');
  assert.equal(f.inputs, 1); assert.equal(f.changed, 1); assert.equal(f.host.querySelector('img'), image);
  assert.equal(f.host.querySelector('select').value, 'followers');
  assert.equal(await f.add().onclick(), true); assert.equal(f.inputs, 1); assert.equal(f.changed, 1);
});

test('video uses Hub public page instead of provider/body; exact 500 inclusive, overflow keeps live draft', async t => {
  const f = fixture(t); assert.equal(await f.offer('/v2/videos/video-a', '動画'), true);
  const href = 'https://hub.invalid/v2/videos/video-a';
  f.textarea.value = 'a'.repeat(500 - href.length - 2);
  assert.equal(await f.add().onclick(), true); assert.equal(f.textarea.value.length, 500);
  f.textarea.value = 'a'.repeat(501 - href.length - 2); const before = f.textarea.value;
  assert.equal(await f.add().onclick(), false); assert.equal(f.textarea.value, before); assert.match(f.controller.element.textContent, /500文字/);
});

test('unsafe/unpinned research/unknown references never navigate or read context', async t => {
  for (const href of ['/v2/research/rp_1?document=doc', '/v2/articles/x?private=1', '/v2/videos/../x', 'https://external.invalid/v2/videos/x?token=private', '/v2/articles/x\n']) {
    const f = fixture(t); assert.equal(await f.offer(href), false); assert.equal(f.reads, 0); assert.equal(f.navigations, 0);
  }
});

test('scope changed after navigation never adopts preview', async t => {
  for (const change of [f => { f.scope = null; }, f => { f.scope = { ...f.scope, epoch: {} }; }, f => { f.scope = { ...f.scope, key: 'device-b' }; }, f => { f.scope = { ...f.scope, origin: 'https://other.invalid' }; }]) {
    const f = fixture(t); f.navigate = async () => { f.destination = true; f.source = false; change(f); };
    assert.equal(await f.offer(), false); assert.equal(f.controller.element.hidden, true); assert.equal(f.inputs, 0);
  }
});

test('detached source, lost view and destroyed controller discard pending acquisition before navigation', async t => {
  for (const stale of [f => { f.source = false; }, f => f.controller.destroy(), f => f.host.remove()]) {
    const f = fixture(t), pending = deferred(); f.getContext = () => pending.promise;
    const offering = f.offer(); stale(f); pending.resolve(f.scope);
    assert.equal(await offering, false); assert.equal(f.navigations, 0); assert.equal(f.inputs, 0);
  }
});

test('old offer cannot replace a newer preview and late cancel cannot append', async t => {
  const f = fixture(t), pending = deferred(); let first = true;
  f.getContext = async () => first ? (first = false, pending.promise) : f.scope;
  const old = f.offer('/v2/articles/old', '古い');
  assert.equal(await f.offer('/v2/videos/new', '新しい'), true);
  pending.resolve(f.scope); assert.equal(await old, false); assert.match(f.controller.element.textContent, /videos\/new/);
  const check = deferred(); f.getContext = () => check.promise;
  const adding = f.add().onclick(); f.controller.invalidate(); check.resolve(f.scope);
  assert.equal(await adding, false); assert.equal(f.textarea.value, '元の草稿\n'); assert.equal(f.controller.element.hidden, true);
});

test('double click reads once; draft remains editable during scope check; failed read and actor change do not append', async t => {
  const f = fixture(t); await f.offer(); const pending = deferred(); let calls = 0;
  f.getContext = () => { calls++; return pending.promise; };
  const adding = f.add().onclick(); assert.equal(await f.add().onclick(), false); f.textarea.value = 'await中の編集';
  pending.resolve(f.scope); assert.equal(await adding, true); assert.equal(calls, 1); assert.match(f.textarea.value, /^await中の編集\n\n/);
  const old = f.textarea.value; f.getContext = async () => { throw Error('private-error'); };
  assert.equal(await f.add().onclick(), false); assert.equal(f.textarea.value, old); assert.doesNotMatch(f.controller.element.textContent, /private-error/);
  f.getContext = async () => ({ ...f.scope, epoch: {} });
  assert.equal(await f.add().onclick(), false); assert.equal(f.textarea.value, old); assert.equal(f.controller.element.hidden, true);
});

test('missing account and stale destination cannot add', async t => {
  const f = fixture(t); f.scope = null; assert.equal(await f.offer(), false); assert.equal(f.navigations, 0);
  const g = fixture(t); await g.offer(); g.destination = false;
  assert.equal(await g.add().onclick(), false); assert.equal(g.changed, 0);
});

test('actual detail button guards detached/stale source and duplicates, never accepts research kind', async t => {
  const f = fixture(t), pending = deferred(); let calls = 0;
  const control = attachContentShare({ document: f.document, host: f.detail, kind: 'article', id: 'a', title: '記事', isCurrent: () => f.source,
    onShare: async input => { calls++; assert.equal(input.href, '/v2/articles/a'); assert.equal(input.isCurrent(), true); return pending.promise; } });
  const click = control.element.onclick(); assert.equal(await control.element.onclick(), false); assert.equal(calls, 1);
  pending.resolve(true); assert.equal(await click, true); f.detail.remove(); assert.equal(await control.element.onclick(), false); assert.equal(calls, 1);
  assert.equal(attachContentShare({ document: f.document, host: f.host, kind: 'research', id: 'private', isCurrent: () => true }), null);
});

test('closing preview keeps every draft field and removes displayed reference', async t => {
  const f = fixture(t); await f.offer();
  [...f.controller.element.querySelectorAll('button')].find(button => button.textContent === '閉じる').onclick();
  assert.equal(f.controller.element.hidden, true); assert.equal(f.controller.element.textContent.includes('hub.invalid'), false);
  assert.equal(f.textarea.value, '元の草稿\n'); assert.equal(f.host.querySelector('select').value, 'followers'); assert.equal(f.host.querySelectorAll('img').length, 1);
});

test('remote origins never become local IDs and identical paths keep distinct source URIs',async t=>{
 const f=fixture(t);f.textarea.value='Original';
 for(const origin of ['https://a.example','https://b.example']){
  assert.equal(await f.controller.offer({href:origin+'/v2/posts/same',title:'Public remote post',isCurrent:()=>true}),true);
  assert.equal(await f.add().onclick(),true);
 }
 assert.equal(f.textarea.value,'Original\n\nhttps://a.example/v2/posts/same\n\nhttps://b.example/v2/posts/same');
});
test('Git preview keeps the commit and ordered base, live draft, image and audience without publication',async t=>{
 const f=fixture(t),href=`https://other.example/v2/research/rp_${'a'.repeat(32)}?commit=${'b'.repeat(64)}&base=${'c'.repeat(64)}#git`,image=f.host.querySelector('img');
 assert.equal(await f.offer(href,''),true);assert.match(f.controller.element.textContent,/コードの変更を紹介/);assert.equal(await f.add().onclick(),true);
 assert.equal(f.textarea.value,'元の草稿\n\n\n'+href);assert.equal(f.host.querySelector('img'),image);assert.equal(f.host.querySelector('select').value,'followers');assert.equal(f.navigations,1);assert.equal(f.inputs,1);
});
test('GitHub previews preserve live draft, attachment and audience until explicit add; duplicate and 500 boundaries hold', async t => {
  const repo = 'https://github.com/owner/repo';
  for (const href of [repo, repo + '/issues/1', repo + '/pull/2', repo + '/commit/' + 'a'.repeat(40), repo + '/commit/' + 'b'.repeat(64)]) {
    const f = fixture(t), image = f.host.querySelector('img'), before = f.textarea.value;
    assert.equal(await f.offer(href, 'GitHub'), true);
    assert.equal(f.textarea.value, before); assert.equal(f.inputs, 0); assert.equal(f.changed, 0);
    assert.equal(f.host.querySelector('img'), image); assert.equal(f.host.querySelector('select').value, 'followers');
    f.textarea.value = 'latest draft'; assert.equal(await f.add().onclick(), true);
    assert.equal(f.textarea.value, 'latest draft\n\n' + href); assert.equal(f.inputs, 1); assert.equal(f.changed, 1);
    assert.equal(await f.add().onclick(), true); assert.equal(f.inputs, 1); assert.equal(f.changed, 1);
    f.textarea.value = 'x'.repeat(500 - href.length - 2); assert.equal(await f.add().onclick(), true); assert.equal(f.textarea.value.length, 500);
    f.textarea.value = 'x'.repeat(501 - href.length - 2); const full = f.textarea.value;
    assert.equal(await f.add().onclick(), false); assert.equal(f.textarea.value, full); assert.match(f.controller.element.textContent, /500文字/);
    assert.equal(f.host.querySelector('img'), image); assert.equal(f.host.querySelector('select').value, 'followers');
  }
});

test('invalid GitHub offers leave the draft untouched without scope reads or navigation', async t => {
  for (const href of ['https://github.com/v2/articles/a', 'https://github.com/owner/repo?token=private', 'https://github.com/owner/repo/issues/01',
    'https://github.com/Owner/repo', 'https://github.com/owner/repo/commit/' + 'a'.repeat(39)]) {
    const f = fixture(t), before = f.textarea.value;
    assert.equal(await f.offer(href), false); assert.equal(f.reads, 0); assert.equal(f.navigations, 0); assert.equal(f.inputs, 0);
    assert.equal(f.textarea.value, before); assert.equal(f.host.querySelectorAll('img').length, 1); assert.equal(f.host.querySelector('select').value, 'followers');
  }
});
