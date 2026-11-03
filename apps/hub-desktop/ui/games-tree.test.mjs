import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { gamesTreeModel, renderGamesTree, gamesRouteKey, sameGamesRoute } from './games-tree.mjs';

const installed = [{ id: 1, title: 'Alpha' }, { id: 2, title: 'Beta' }, { id: 3, title: 'Gamma' }];

function mount(t, options = {}, route = { page: 'library' }) {
  const dom = new JSDOM('<aside id="col"></aside>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderGamesTree({ document, host, model: gamesTreeModel(options), route, onGo: r => gone.push(gamesRouteKey(r)) });
  return { document, host, tree, gone };
}
const labels = host => [...host.querySelectorAll('.sidebar-context-item')].map(n => n.textContent);

test('roots are ライブラリ (installed games as children) and ストア', t => {
  const f = mount(t, { installed });
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-tree-root')].map(n => n.textContent), ['ライブラリ', 'ストア']);
  assert.deepEqual(labels(f.host), ['ライブラリ', 'Alpha', 'Beta', 'Gamma', 'ストア']);
  assert.equal(f.host.querySelectorAll('.sidebar-tree').length, 2);
});

test('edges: first and last child carry the curved-line marks; a single child gets both', t => {
  const f = mount(t, { installed });
  const kids = [...f.host.querySelectorAll('.sidebar-tree-children > .sidebar-context-item')];
  assert.ok(kids[0].classList.contains('is-tree-first') && !kids[0].classList.contains('is-tree-last'));
  assert.ok(kids[2].classList.contains('is-tree-last'));
  const one = mount(t, { installed: [installed[0]] });
  const only = one.host.querySelector('.sidebar-tree-children > .sidebar-context-item');
  assert.ok(only.classList.contains('is-tree-first') && only.classList.contains('is-tree-last'));
});

test('with nothing installed the library has no branch; bad rows are dropped', t => {
  const f = mount(t, { installed: [null, { id: 5 }, { title: 'no id' }] });
  assert.equal(f.host.querySelectorAll('.sidebar-tree-children').length, 0);
  assert.deepEqual(labels(f.host), ['ライブラリ', 'ストア']);
});

test('clicking only reports the route and never rebuilds the column', t => {
  const f = mount(t, { installed });
  const before = [...f.host.children];
  for (const button of f.tree.rows()) button.click();
  assert.deepEqual(f.gone, ['library', 'game:1', 'game:2', 'game:3', 'store']);
  assert.deepEqual([...f.host.children], before);
});

test('select moves the on mark and aria-current without touching the DOM', t => {
  const f = mount(t, { installed });
  const on = () => [...f.host.querySelectorAll('.on')].map(n => n.textContent);
  assert.deepEqual(on(), ['ライブラリ']);
  f.tree.select({ page: 'game', id: '2' });
  assert.deepEqual(on(), ['Beta']);
  assert.equal(f.host.querySelectorAll('[aria-current="page"]').length, 1);
  f.tree.select({ page: 'store' });
  assert.deepEqual(on(), ['ストア']);
  f.tree.select({ page: 'game', id: 2 });
  assert.deepEqual(on(), ['Beta']);
});

test('route helpers; children are capped; no raw colours in the tree module', () => {
  assert.ok(sameGamesRoute({ page: 'game', id: 1 }, { page: 'game', id: '1' }));
  assert.ok(!sameGamesRoute({ page: 'store' }, { page: 'library' }));
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `G${i}` }));
  assert.equal(gamesTreeModel({ installed: many })[0].children.length, 40);
  assert.doesNotMatch(readFileSync(new URL('./games-tree.mjs', import.meta.url), 'utf8'), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
