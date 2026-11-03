import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { articleTreeModel, renderArticleTree, routeKey, sameRoute, MAX_TREE_TAGS } from './article-tree.mjs';

const tags = ['Hub', 'デザイン'];

function mount(t, options = {}, route = { page: 'home' }) {
  const dom = new JSDOM('<aside id="col"></aside>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderArticleTree({ document, host, model: articleTreeModel(options), route, onGo: target => gone.push(routeKey(target)) });
  return { document, host, tree, gone };
}
const labels = host => [...host.querySelectorAll('.sidebar-context-item')].map(node => node.textContent);

test('roots are ホーム (フォロー中のタグ with each tag as a child, 下書き, シリーズ) and マガジン (保存した記事)', t => {
  const f = mount(t, { tags });
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-tree-root')].map(node => node.textContent), ['ホーム', 'マガジン']);
  assert.deepEqual(labels(f.host), ['ホーム', 'フォロー中のタグ', '#Hub', '#デザイン', '下書き', 'シリーズ', 'マガジン', '保存した記事']);
  const nested = f.host.querySelector('.article-tree-nested');
  assert.deepEqual([...nested.querySelectorAll('.sidebar-context-item')].map(node => node.textContent), ['#Hub', '#デザイン']);
  assert.ok(f.host.querySelector('[data-route="tags"]').nextElementSibling === nested, 'the tags hang right under their heading');
});

test('without followed tags the heading stays and has no nested group; duplicates and blanks are dropped; the list is capped', t => {
  assert.equal(mount(t).host.querySelectorAll('.article-tree-nested').length, 0);
  assert.deepEqual(labels(mount(t, { tags: ['Hub', 'Hub', ' ', 3, 'A'] }).host).slice(1, 4), ['フォロー中のタグ', '#Hub', '#A']);
  const many = Array.from({ length: 40 }, (_, index) => `t${index}`);
  assert.equal(mount(t, { tags: many }).host.querySelectorAll('.article-tree-leaf').length, MAX_TREE_TAGS);
});

test('it uses the feed tree classes and curved-line edge marks on every branch', t => {
  const f = mount(t, { tags });
  assert.equal(f.host.querySelectorAll('.sidebar-tree').length, 2);
  const kids = f.host.querySelector('.sidebar-tree-children');
  const direct = [...kids.querySelectorAll(':scope > .sidebar-context-item')];
  assert.deepEqual(direct.map(node => node.textContent), ['フォロー中のタグ', '下書き', 'シリーズ']);
  assert.ok(direct[0].classList.contains('is-tree-first'));
  assert.ok(direct.at(-1).classList.contains('is-tree-last'));
  const leaves = [...f.host.querySelectorAll('.article-tree-nested > .sidebar-context-item')];
  assert.ok(leaves[0].classList.contains('is-tree-first') && leaves.at(-1).classList.contains('is-tree-last'));
  assert.equal(f.host.querySelectorAll('.is-tree-first').length, 3);
  assert.equal(f.host.querySelectorAll('.is-tree-last').length, 3);
});

test('pressing a row only reports the route; the column is not rebuilt and only the selection moves', t => {
  const f = mount(t, { tags });
  const before = [...f.host.querySelectorAll('.sidebar-context-item')];
  f.host.querySelector('[data-route="tag:デザイン"]').click();
  f.host.querySelector('[data-route="drafts"]').click();
  assert.deepEqual(f.gone, ['tag:デザイン', 'drafts']);
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-context-item')], before, 'same nodes: the column did not change');
  f.tree.select({ page: 'tag', id: 'デザイン' });
  assert.deepEqual([...f.host.querySelectorAll('.on')].map(node => node.textContent), ['#デザイン']);
  f.tree.select({ page: 'drafts' });
  assert.deepEqual([...f.host.querySelectorAll('.on')].map(node => node.textContent), ['下書き']);
  assert.equal(f.host.querySelectorAll('[aria-current]').length, 1);
});

test('selection follows the route on first paint; マガジン and 保存した記事 never both light up', t => {
  assert.deepEqual([...mount(t, { tags }).host.querySelectorAll('.on')].map(node => node.textContent), ['ホーム']);
  const saved = mount(t, { tags }, { page: 'saved' });
  assert.deepEqual([...saved.host.querySelectorAll('.on')].map(node => node.textContent), ['保存した記事']);
  assert.deepEqual([...mount(t, { tags }, { page: 'nowhere' }).host.querySelectorAll('.on')], []);
});

test('シリーズ says it opens the web; no other row does', t => {
  const f = mount(t, { tags });
  const web = [...f.host.querySelectorAll('[data-web="true"]')];
  assert.deepEqual(web.map(node => node.textContent), ['シリーズ']);
  assert.match(web[0].title, /ブラウザで開きます/);
});

test('sameRoute compares the id too', () => {
  assert.ok(sameRoute({ page: 'tag', id: 'a' }, { page: 'tag', id: 'a' }));
  assert.ok(!sameRoute({ page: 'tag', id: 'a' }, { page: 'tag', id: 'b' }));
  assert.ok(!sameRoute(null, { page: 'home' }));
});
