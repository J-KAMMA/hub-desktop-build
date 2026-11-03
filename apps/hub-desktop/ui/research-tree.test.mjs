import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { researchTreeModel, renderResearchTree, markEdges, routeKey, sameRoute } from './research-tree.mjs';

const projects = [{ id: 'rp_a', title: '海洋プラスチック' }, { id: 'rp_b', title: '音声検出モデル' }, { id: 'rp_c', title: '' }];

function mount(t, list = projects, route = { page: 'projects' }) {
  const dom = new JSDOM('<aside id="col"></aside>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderResearchTree({ document, host, model: researchTreeModel({ projects: list }), route, onGo: target => gone.push(routeKey(target)) });
  return { document, host, tree, gone };
}
const labels = host => [...host.querySelectorAll('.sidebar-context-item')].map(node => node.textContent);

test('the roots are プロジェクト (children: the projects) and 探す (no children)', t => {
  const f = mount(t);
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-tree-root')].map(node => node.textContent), ['プロジェクト', '探す']);
  assert.deepEqual(labels(f.host), ['プロジェクト', '海洋プラスチック', '音声検出モデル', 'プロジェクト', '探す']);
  const groups = [...f.host.querySelectorAll('.sidebar-tree')];
  assert.equal(groups.length, 2);
  assert.ok(groups[0].querySelector('.sidebar-tree-children'));
  assert.equal(groups[1].querySelector('.sidebar-tree-children'), null, '探す has no branch');
});

test('model: items without a string id are dropped, an empty title falls back, and no projects means no branch', () => {
  const model = researchTreeModel({ projects: [{ id: 5, title: 'x' }, null, { title: 'no id' }, { id: 'rp_ok', title: '' }] });
  assert.deepEqual(model[0].children.map(item => item.label), ['プロジェクト']);
  assert.deepEqual(model[0].children[0].route, { page: 'project', id: 'rp_ok' });
  assert.deepEqual(researchTreeModel().map(root => root.label), ['プロジェクト', '探す']);
  assert.deepEqual(researchTreeModel()[0].children, []);
});

test('the branch uses the shared curved-line classes and marks first and last', t => {
  const f = mount(t);
  const kids = f.host.querySelector('.sidebar-tree-children');
  assert.equal(kids.getAttribute('role'), 'group');
  const items = [...kids.querySelectorAll(':scope > .sidebar-context-item')];
  assert.equal(items.length, 3);
  assert.ok(items[0].classList.contains('is-tree-first'));
  assert.ok(items.at(-1).classList.contains('is-tree-last'));
  assert.ok(!items[1].classList.contains('is-tree-first') && !items[1].classList.contains('is-tree-last'));
  markEdges(kids);
  assert.equal(kids.querySelectorAll('.is-tree-first').length, 1);
  assert.equal(kids.querySelectorAll('.is-tree-last').length, 1);
});

test('a single child is both first and last; an empty branch is not drawn', t => {
  const one = mount(t, [projects[0]]);
  const only = one.host.querySelector('.sidebar-tree-children > .sidebar-context-item');
  assert.ok(only.classList.contains('is-tree-first') && only.classList.contains('is-tree-last'));
  const none = mount(t, []);
  assert.equal(none.host.querySelector('.sidebar-tree-children'), null);
});

test('clicking a row only calls onGo: the column keeps its nodes and does not rebuild', t => {
  const f = mount(t);
  const before = [...f.host.querySelectorAll('.sidebar-context-item')];
  f.host.querySelector('[data-route="project:rp_b"]').click();
  f.host.querySelector('[data-route="discover"]').click();
  f.host.querySelector('[data-route="projects"]').click();
  assert.deepEqual(f.gone, ['project:rp_b', 'discover', 'projects']);
  const after = [...f.host.querySelectorAll('.sidebar-context-item')];
  assert.equal(after.length, before.length);
  assert.ok(after.every((node, index) => node === before[index]), 'the same buttons, nothing rebuilt');
});

test('select marks exactly one row and moves it without rebuilding', t => {
  const f = mount(t, projects, { page: 'projects' });
  const on = () => f.host.querySelectorAll('.sidebar-context-item.on');
  assert.equal(on().length, 1);
  assert.equal(on()[0].dataset.route, 'projects');
  f.tree.select({ page: 'project', id: 'rp_b' });
  assert.equal(on().length, 1);
  assert.equal(on()[0].textContent, '音声検出モデル');
  assert.equal(on()[0].getAttribute('aria-current'), 'page');
  f.tree.select({ page: 'discover' });
  assert.equal(on()[0].textContent, '探す');
  assert.equal(f.host.querySelectorAll('[aria-current="page"]').length, 1);
  f.tree.select({ page: 'project', id: 'unknown' });
  assert.equal(on().length, 0);
});

test('sameRoute and routeKey compare the id as well', () => {
  assert.ok(sameRoute({ page: 'project', id: 'a' }, { page: 'project', id: 'a' }));
  assert.ok(!sameRoute({ page: 'project', id: 'a' }, { page: 'project', id: 'b' }));
  assert.ok(!sameRoute({ page: 'projects' }, { page: 'project', id: 'a' }));
  assert.ok(!sameRoute(null, { page: 'projects' }));
  assert.equal(routeKey({ page: 'discover' }), 'discover');
  assert.equal(routeKey({ page: 'project', id: 'x' }), 'project:x');
});

test('every row is a labelled button with an ellipsis title and the root rows carry an icon', t => {
  const f = mount(t);
  for (const button of f.tree.rows()) {
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.ok(button.title.length > 0);
  }
  assert.ok(f.host.querySelectorAll('.sidebar-tree-root > svg.sidebar-icon').length === 2);
});
