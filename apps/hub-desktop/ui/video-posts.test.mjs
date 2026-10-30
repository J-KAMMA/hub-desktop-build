import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createVideoPosts } from './video-posts.mjs';

const videoId = 'video_1';
const post = (n, extra = {}) => ({ id: `post_${n}`, body: `本文${n}`, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t, { data = { posts: [post(1), post(2)], nextCursor: null }, state = {}, ...options } = {}) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost' }), document = dom.window.document;
  const f = { dom, document, state, data, calls: [] };
  f.respond = async (name) => name === 'hub_detail' ? f.data : { post: post(99) };
  f.settings = {
    videoId, state,
    renderPost: item => { const node = document.createElement('article'); node.className = 'card post'; node.dataset.postId = item.id; node.textContent = item.body; return node; },
    invoke: async (name, args) => { f.calls.push([name, args]); return f.respond(name, args); },
    ...options,
  };
  const controller = createVideoPosts(document, f.settings);
  document.querySelector('main').append(controller.element);
  f.controller = controller; f.element = controller.element;
  await controller.ready;
  t.after(() => { controller.destroy(); dom.window.close(); });
  return f;
}
const button = (f, text) => [...f.element.querySelectorAll('button')].find(item => item.textContent === text);
const ids = f => [...f.element.querySelectorAll('[data-post-id]')].map(node => node.dataset.postId);
const fill = (f, value) => { const input = f.element.querySelector('textarea'); input.value = value; input.dispatchEvent(new f.dom.window.Event('input')); };
const submit = f => f.element.querySelector('form').onsubmit(new f.dom.window.Event('submit', { cancelable: true }));

test('loads through the exact native detail and renders with the injected renderer', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls, [['hub_detail', { name: 'video_posts', ids: [videoId] }]]);
  assert.deepEqual(ids(f), ['post_1', 'post_2']);
  assert.equal(button(f, 'もっと見る').hidden, true);
  assert.match(f.element.querySelector('h3').textContent, /ポスト/);
});

test('empty list says so, and a bad payload keeps the draft with a friendly message', async t => {
  const f = await fixture(t, { data: { posts: [], nextCursor: null }, state: { body: '下書き' } });
  assert.match(f.element.textContent, /まだポストはありません/);
  assert.equal(f.element.querySelector('textarea').value, '下書き');
  f.data = { posts: 'x' };
  await f.controller.reload();
  assert.match(f.element.textContent, /取得できませんでした/);
  assert.equal(f.element.querySelector('textarea').value, '下書き');
});

test('もっと見る follows nextCursor, dedupes and hides at the end', async t => {
  const f = await fixture(t, { data: { posts: [post(1), post(2)], nextCursor: 'c1' } });
  assert.equal(button(f, 'もっと見る').hidden, false);
  f.data = { posts: [post(2), post(3)], nextCursor: null };
  await button(f, 'もっと見る').onclick();
  assert.deepEqual(f.calls[1], ['hub_detail', { name: 'video_posts_page', ids: [videoId, 'c1'] }]);
  assert.deepEqual(ids(f), ['post_1', 'post_2', 'post_3']);
  assert.equal(button(f, 'もっと見る').hidden, true);
});

test('a repeated cursor is rejected as a failed page instead of looping', async t => {
  const f = await fixture(t, { data: { posts: [post(1)], nextCursor: 'c1' } });
  f.data = { posts: [post(2)], nextCursor: 'c1' };
  await button(f, 'もっと見る').onclick();
  assert.deepEqual(ids(f), ['post_1']);
  assert.match(f.element.textContent, /続きを取得できませんでした/);
});

test('posting sends the closed payload, prepends the result and clears the draft', async t => {
  const f = await fixture(t);
  fill(f, '  面白かった  ');
  assert.equal(f.state.body, '  面白かった  ');
  await submit(f);
  assert.deepEqual(f.calls[1], ['hub_client_action', { action: 'video_post_create', target: videoId, options: { body: '面白かった' } }]);
  assert.deepEqual(ids(f), ['post_99', 'post_1', 'post_2']);
  assert.equal(f.state.body, '');
  assert.equal(f.element.querySelector('textarea').value, '');
});

test('repost sends an empty body and is unavailable while text is typed', async t => {
  const f = await fixture(t);
  fill(f, 'x');
  assert.equal(button(f, 'リポスト').disabled, true);
  await button(f, 'リポスト').onclick();
  assert.equal(f.calls.length, 1);
  fill(f, '');
  await button(f, 'リポスト').onclick();
  assert.deepEqual(f.calls[1], ['hub_client_action', { action: 'video_post_create', target: videoId, options: { body: '' } }]);
  assert.equal(ids(f)[0], 'post_99');
});

test('empty text, over-limit text and double submit never send twice', async t => {
  const f = await fixture(t);
  fill(f, '   '); await submit(f);
  fill(f, 'x'.repeat(501)); await submit(f);
  assert.equal(f.calls.length, 1);
  const gate = deferred();
  f.respond = async () => gate.promise;
  fill(f, 'ok');
  const first = submit(f); await submit(f); await button(f, 'リポスト').onclick();
  assert.equal(f.calls.length, 2);
  gate.resolve({ post: post(7) }); await first;
  assert.equal(ids(f)[0], 'post_7');
});

test('a failed or unconfirmed post keeps the draft and shows a friendly message', async t => {
  const f = await fixture(t);
  fill(f, '残す');
  f.respond = async () => { throw Error('boom'); };
  await submit(f);
  assert.equal(f.state.body, '残す');
  assert.match(f.element.textContent, /確認できませんでした/);
  assert.doesNotMatch(f.element.textContent, /boom/);
  f.respond = async () => ({ nothing: true });
  await submit(f);
  assert.deepEqual(ids(f), ['post_1', 'post_2']);
  assert.equal(f.element.querySelector('textarea').value, '残す');
});

test('stale responses are ignored after dispose or isCurrent turns false', async t => {
  const gate = deferred();
  const f = await fixture(t);
  f.respond = async () => gate.promise;
  const reloading = f.controller.reload();
  f.controller.destroy();
  gate.resolve({ posts: [post(5)], nextCursor: null });
  await reloading; await tick();
  assert.deepEqual(ids(f), ['post_1', 'post_2']);

  let current = true;
  const g = await fixture(t, { isCurrent: () => current });
  const gate2 = deferred();
  g.respond = async () => gate2.promise;
  const pendingReload = g.controller.reload();
  current = false;
  gate2.resolve({ posts: [post(8)], nextCursor: null });
  await pendingReload;
  assert.deepEqual(ids(g), ['post_1', 'post_2']);
});

test('account change invalidates the section', async t => {
  const f = await fixture(t);
  f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));
  assert.equal(f.element.children.length, 0);
  assert.equal(f.state.body, '');
});

test('a link back to this same video is hidden on the video page; other links stay', async t => {
  const f = await fixture(t, { renderPost: item => {
    const node = f_doc.createElement('article'); node.dataset.postId = item.id;
    for (const href of ['http://127.0.0.1:3020/v2/videos/video_1', '/v2/videos/video_2', 'https://example.com/']) { const a = f_doc.createElement('a'); a.href = href; node.append(a); }
    return node;
  } });
  const links = [...f.element.querySelectorAll('a')];
  assert.deepEqual(links.map(a => a.hidden), [true, false, false, true, false, false]);
});
let f_doc; { const { JSDOM: D } = await import('jsdom'); f_doc = new D('').window.document; }

test('the blank lines before a hidden self-link are trimmed so the post does not end in empty space', async t => {
  const f = await fixture(t, { data: { posts: [post(1)], nextCursor: null }, renderPost: item => {
    const node = f_doc.createElement('article'); node.dataset.postId = item.id;
    const a = f_doc.createElement('a'); a.href = '/v2/videos/video_1';
    node.append(f_doc.createTextNode('本文\n\n'), a);
    return node;
  } });
  assert.equal(f.element.querySelector('article').firstChild.data, '本文');
});
