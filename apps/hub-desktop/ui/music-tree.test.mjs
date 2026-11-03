import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { musicTreeModel, renderMusicTree, routeKey, sameRoute } from './music-tree.mjs';

const playlists = [{ id: 'pl1', title: '作業用' }, { id: 'pl2', title: '夜に聴く' }];

function mount(t, options = {}, route = { page: 'home' }) {
  const dom = new JSDOM('<aside id="col"></aside>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderMusicTree({ document, host, model: musicTreeModel(options), route, onGo: target => gone.push(routeKey(target)) });
  return { document, host, tree, gone };
}
const labels = host => [...host.querySelectorAll('.sidebar-context-item')].map(node => node.textContent);

test('the tree has ホーム and ライブラリ (お気に入り, プレイリスト with each playlist as a child, アーティスト); no アップロード without an upload path', t => {
  const f = mount(t, { playlists });
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-tree-root')].map(node => node.textContent), ['ホーム', 'ライブラリ']);
  assert.deepEqual(labels(f.host), ['ホーム', 'ライブラリ', 'お気に入り', 'プレイリスト', '作業用', '夜に聴く', 'アーティスト']);
  const nested = f.host.querySelector('.music-tree-nested');
  assert.deepEqual([...nested.querySelectorAll('.sidebar-context-item')].map(node => node.textContent), ['作業用', '夜に聴く']);
  assert.ok(f.host.querySelector('[data-route="playlists"]').nextElementSibling === nested, 'the playlists hang right under their heading');
});

test('アップロード is a third root only when the user can upload', t => {
  assert.deepEqual([...mount(t, { canUpload: true }).host.querySelectorAll('.sidebar-tree-root')].map(node => node.textContent), ['ホーム', 'ライブラリ', 'アップロード']);
});

test('it uses the feed tree classes and curved-line edge marks: first and last child of every branch', t => {
  const f = mount(t, { playlists });
  assert.ok(f.host.querySelector('.sidebar-tree > .sidebar-tree-children'));
  const kids = f.host.querySelector('.sidebar-tree-children');
  const direct = [...kids.querySelectorAll(':scope > .sidebar-context-item')];
  assert.ok(direct[0].classList.contains('is-tree-first'));
  assert.ok(direct.at(-1).classList.contains('is-tree-last'));
  const nested = f.host.querySelector('.music-tree-nested');
  const leaves = [...nested.querySelectorAll(':scope > .sidebar-context-item')];
  assert.ok(leaves[0].classList.contains('is-tree-first') && leaves.at(-1).classList.contains('is-tree-last'));
  assert.equal(f.host.querySelectorAll('.is-tree-first').length, 2);
});

test('pressing a row only reports the route; the column is not rebuilt and only the selection moves', t => {
  const f = mount(t, { playlists });
  const before = [...f.host.querySelectorAll('.sidebar-context-item')];
  f.host.querySelector('[data-route="playlist:pl2"]').click();
  assert.deepEqual(f.gone, ['playlist:pl2']);
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-context-item')], before, 'same nodes: the column did not change');
  f.tree.select({ page: 'playlist', id: 'pl2' });
  assert.deepEqual([...f.host.querySelectorAll('.on')].map(node => node.textContent), ['夜に聴く']);
  assert.equal(f.host.querySelector('.on').getAttribute('aria-current'), 'page');
  f.tree.select({ page: 'artists' });
  assert.deepEqual([...f.host.querySelectorAll('.on')].map(node => node.textContent), ['アーティスト']);
  assert.equal(f.host.querySelectorAll('[aria-current]').length, 1);
});

test('selection follows the route on first paint, and the ライブラリ root and its お気に入り row never both light up', t => {
  assert.deepEqual([...mount(t, { playlists }, { page: 'home' }).host.querySelectorAll('.on')].map(node => node.textContent), ['ホーム']);
  assert.deepEqual([...mount(t, { playlists }, { page: 'favorites' }).host.querySelectorAll('.on')].map(node => node.textContent), ['お気に入り']);
  assert.deepEqual([...mount(t, { playlists }, null).host.querySelectorAll('.on')], []);
  assert.ok(sameRoute({ page: 'playlist', id: 'a' }, { page: 'playlist', id: 'a' }));
  assert.ok(!sameRoute({ page: 'playlist', id: 'a' }, { page: 'playlist', id: 'b' }));
});

test('every row is a keyboard-reachable button with an accessible label, and the tree draws no colour of its own', t => {
  const f = mount(t, { playlists });
  for (const node of f.host.querySelectorAll('.sidebar-context-item')) { assert.equal(node.tagName, 'BUTTON'); assert.equal(node.type, 'button'); assert.ok(node.title); }
  assert.deepEqual([...f.host.querySelectorAll('[role="group"]')].map(node => node.getAttribute('aria-label')).slice(0, 2), ['ライブラリ', 'プレイリスト']);
  const source = readFileSync(new URL('./music-tree.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
});

test('app.js keeps the music tree for every music detail, so opening an item never swaps the column', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const set = /const MUSIC_TREE_DETAILS = new Set\(\[([^\]]+)\]\)/.exec(app);
  assert.ok(set);
  for (const name of ['music_library', 'music_playlists', 'music_playlist', 'music_artists', 'music_artist', 'music_album']) assert.ok(set[1].includes(`"${name}"`), name);
  assert.ok(!set[1].includes('music_work'), 'there is no work page');
  for (const name of ['music_playlist', 'music_artists']) {
    assert.match(app, new RegExp(`${name}:"discovery"`));
    assert.match(app, new RegExp(`${name}:'music'`));
  }
});
