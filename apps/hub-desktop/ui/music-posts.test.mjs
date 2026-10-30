import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContentPosts } from './video-posts.mjs';

const workId = 'music:00000000-0000-4000-8000-000000000000';
const post = n => ({ id: `post_${n}`, body: `本文${n}` });
async function fixture(t, id = workId, data = { posts: [post(1)], nextCursor: 'c1' }) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost' }), document = dom.window.document;
  const calls = [];
  const controller = createContentPosts(document, {
    kind: 'music', id, state: {},
    renderPost: item => {
      const node = document.createElement('article'); node.dataset.postId = item.id; node.textContent = item.body;
      for (const href of ['/v2/music/works/music%3A00000000-0000-4000-8000-000000000000', '/v2/music/works/other', 'https://example.com/']) { const a = document.createElement('a'); a.setAttribute('href', href); node.append(a); }
      return node;
    },
    invoke: async (name, args) => { calls.push([name, args]); return name === 'hub_detail' ? data : { post: post(99) }; },
  });
  document.querySelector('main').append(controller.element);
  await controller.ready;
  t.after(() => { controller.destroy(); dom.window.close(); });
  return { controller, element: controller.element, calls, dom };
}
const button = (f, text) => [...f.element.querySelectorAll('button')].find(item => item.textContent === text);

test('music posts use the music native names, copy and self-link hiding', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.calls[0], ['hub_detail', { name: 'music_posts', ids: [workId] }]);
  assert.match(f.element.textContent, /この曲についてのHubのポストです。リポストすると曲へのリンクが付きます。/);
  const hidden = [...f.element.querySelectorAll('a')].filter(a => a.hidden).map(a => a.getAttribute('href'));
  assert.deepEqual(hidden, ['/v2/music/works/music%3A00000000-0000-4000-8000-000000000000']);
  {
    await button(f, 'もっと見る').onclick();
    assert.deepEqual(f.calls[1], ['hub_detail', { name: 'music_posts_page', ids: [workId, 'c1'] }]);
  }
});

test('music posting and reposting go through music_post_create', async t => {
  const f = await fixture(t, 'work_1');
  const input = f.element.querySelector('textarea');
  input.value = '良い曲'; input.dispatchEvent(new f.dom.window.Event('input'));
  await f.element.querySelector('form').onsubmit(new f.dom.window.Event('submit', { cancelable: true }));
  assert.deepEqual(f.calls.at(-1), ['hub_client_action', { action: 'music_post_create', target: 'work_1', options: { body: '良い曲' } }]);
  await button(f, 'リポスト').onclick();
  assert.deepEqual(f.calls.at(-1), ['hub_client_action', { action: 'music_post_create', target: 'work_1', options: { body: '' } }]);
});

test('invalid music ids and kinds are rejected', () => {
  const document = new JSDOM('').window.document;
  const base = { renderPost: () => document.createElement('div'), invoke: async () => ({ posts: [] }) };
  for (const id of ['', '../x', 'music:bad', 'a b', 'x'.repeat(129)]) assert.throws(() => createContentPosts(document, { ...base, kind: 'music', id }));
  assert.throws(() => createContentPosts(document, { ...base, kind: 'book', id: 'x' }));
  assert.throws(() => createContentPosts(document, { ...base, kind: 'video', id: workId }));
});
