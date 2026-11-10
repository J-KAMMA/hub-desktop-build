import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createThreadReader } from './thread-reader.mjs';
import { createThreadStateControls } from './thread-state-controls.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderThreadDetail('), end = source.indexOf('// --- 記事・Hubpedia・本 ---', start);

function mount(data = {}) {
  const { window } = new JSDOM('<main/>'), document = window.document, target = document.querySelector('main');
  const entry = { ids: ['t1'] }, picked = [], calls = [];
  const invoke = async (name, args) => { calls.push({ name, args }); return {}; };
  const globals = { createThreadContentCard: () => ({ root: document.createElement('span') }), openCommunityContent() {}, createThreadPostControls: () => ({ element: document.createElement('span'), destroy() {} }), articleEditorScope: async () => null,
    document, window, LANGUAGE_LABELS: {}, REGION_LABELS: {}, relTime: () => '', invoke, openDetail() {}, openListPicker: (...a) => picked.push(a), detailRenderRevision: 0, researchAccountGeneration: 0, currentView: 'detail', detailTrail: [entry],
    researchEditorOptions: () => ({ invoke }), createThreadStateControls, createThreadReader, applyThreadLinks() {}, threadPostCard: (post) => Object.assign(document.createElement('article'), { textContent: post.body, className: 'thread-post' }),
    threadKnowledgeControls: () => document.createElement('section'), createThreadReplyTarget: () => ({ element: document.createElement('form'), quote() {}, destroy() {} }), friendlyError: String, renderDetailEntry() {}, detailSection: () => document.createElement('section'), catalogCard: () => document.createElement('div'), showNotice() {} };
  const render = new Function(...Object.keys(globals), source.slice(start, end) + ';return renderThreadDetail;')(...Object.values(globals));
  const full = { thread: { id: 't1', title: '題名', boardKey: 'b', postCount: 2, status: 'open', tags: ['x'] }, posts: [{ id: 'p1', no: 1, body: 'one', createdAt: '2026-11-01T00:00:00Z' }, { id: 'p2', no: 2, body: 'two', createdAt: '2026-11-02T00:00:00Z' }], viewer: { id: 'me', lastReadPostNo: 0, following: false, canManageStatus: true }, ...data };
  render(target, full, entry);
  return { window, document, target, picked, calls };
}

test('the thread top is one card: title row with 追跡 and ⋯, then meta, tags and the search inside it', (t) => {
  const f = mount(); t.after(() => f.window.close());
  const cards = [...f.target.children].filter((node) => node.classList.contains('card'));
  assert.equal(cards[0].classList.contains('thread-head'), true);
  assert.equal(f.target.querySelectorAll('.thread-head').length, 1);
  const row = f.target.querySelector('.thread-head-row');
  assert.equal(row.querySelector('h3').textContent, '題名');
  assert.deepEqual([...row.querySelectorAll('.thread-follow, .thread-more > summary')].map((n) => n.textContent), ['追跡する', '⋯']);
  const head = f.target.querySelector('.thread-head');
  assert.ok(head.querySelector('input[type="search"]'));
  assert.ok(head.querySelector('details > summary'));
  assert.equal(f.target.querySelector('.thread-reader > form'), null);
  // 先頭の枠は1枚だけ：状態の枠も検索の枠も別に積まない。
  const before = [...f.target.children].slice(0, [...f.target.children].findIndex((node) => node.classList.contains('thread-reader')));
  assert.equal(before.length, 1);
});

test('less-used actions live in the ⋯ menu: リストに追加, 既読, and moderators get the 受付 buttons', (t) => {
  const f = mount(); t.after(() => f.window.close());
  const items = [...f.target.querySelectorAll('.thread-more-list button')].map((b) => b.textContent);
  assert.deepEqual(items, ['リストに追加', 'ここまで既読にする', '受付を終了', '受付を再開']);
  f.target.querySelector('.thread-more-list .community-more-item').click();
  assert.equal(f.picked.length, 1); assert.equal(f.picked[0][0], 'thread'); assert.equal(f.picked[0][1], 't1');
  const guest = mount({ viewer: null }); t.after(() => guest.window.close());
  assert.equal(guest.target.querySelector('.thread-follow'), null);
  assert.equal(guest.target.querySelectorAll('.thread-head').length, 1);
});

test('the header search still filters the posts', (t) => {
  const f = mount(); t.after(() => f.window.close());
  const search = f.target.querySelector('.thread-head input[type="search"]');
  assert.match(f.target.querySelector('.thread-reader').textContent, /one/);
  search.value = 'two'; search.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const text = f.target.querySelector('.thread-reader').textContent;
  assert.match(text, /two/); assert.doesNotMatch(text, /one/);
});
