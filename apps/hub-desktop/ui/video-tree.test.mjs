import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { videoTreeModel, renderVideoTree, routeKey, sameRoute } from './video-tree.mjs';

const channels = [{ name: '朝のテック' }, { name: 'まんぷく食堂' }, { name: '宇宙のはなし' }];

function mount(t, options = {}, route = { page: 'home' }, extra = {}) {
  const dom = new JSDOM('<aside id="col"></aside>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderVideoTree({ document, host, model: videoTreeModel(options), route, onGo: target => gone.push(routeKey(target)), ...extra });
  return { document, host, tree, gone };
}
const labels = host => [...host.querySelectorAll('.sidebar-context-item')].map(node => node.textContent);

test('roots are ホーム, ショート, フォロー中 (the followed profiles) and ライブラリ (後で見る, 再生リスト, 履歴, 自分の動画)', t => {
  const f = mount(t, { channels, signedIn: true });
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-tree-root')].map(node => node.textContent), ['ホーム', 'ショート', 'フォロー中', 'ライブラリ']);
  assert.deepEqual(labels(f.host), ['ホーム', 'ショート', 'フォロー中', '朝のテック', 'まんぷく食堂', '宇宙のはなし', 'ライブラリ', 'あとで見る', '再生リスト', '履歴', '自分の動画']);
});

test('without an account there is no フォロー中 root; without an upload path there is no 自分の動画', t => {
  const f = mount(t, { channels, signedIn: false, canUpload: false });
  assert.deepEqual(labels(f.host), ['ホーム', 'ショート', 'ライブラリ', 'あとで見る', '再生リスト', '履歴']);
});

test('an empty channel branch carries one quiet note, by status, and no invented channel', t => {
  const read = status => mount(t, { channels: [], signedIn: true, channelsStatus: status }).host.querySelector('.sidebar-tree-note').textContent;
  assert.equal(read('done'), 'まだフォローしていません');
  assert.equal(read('loading'), '読み込み中…');
  assert.equal(read('failed'), '読み込めませんでした');
  const note = mount(t, { channels: [], signedIn: true }).host.querySelector('.sidebar-tree-note');
  assert.ok(note.classList.contains('is-tree-first') && note.classList.contains('is-tree-last'), 'a lone note is both ends of its line');
  assert.equal(mount(t, { channels, signedIn: true }).host.querySelector('.sidebar-tree-note'), null);
});

test('it uses the feed tree classes and the curved-line edge marks on every branch', t => {
  const f = mount(t, { channels, signedIn: true });
  assert.equal(f.host.querySelectorAll('.sidebar-tree > .sidebar-tree-children').length, 2);
  for (const kids of f.host.querySelectorAll('.sidebar-tree-children')) {
    const direct = [...kids.querySelectorAll(':scope > .sidebar-context-item')];
    assert.ok(direct[0].classList.contains('is-tree-first'));
    assert.ok(direct.at(-1).classList.contains('is-tree-last'));
    assert.equal(kids.querySelectorAll('.is-tree-first').length, 1);
    assert.equal(kids.querySelectorAll('.is-tree-last').length, 1);
  }
});

test('pressing a row only reports the route; the column is not rebuilt and only the selection moves', t => {
  const f = mount(t, { channels, signedIn: true });
  const before = [...f.host.querySelectorAll('.sidebar-context-item')];
  f.host.querySelector('[data-route="channel:まんぷく食堂"]').click();
  f.host.querySelector('[data-route="history"]').click();
  assert.deepEqual(f.gone, ['channel:まんぷく食堂', 'history']);
  assert.deepEqual([...f.host.querySelectorAll('.sidebar-context-item')], before, 'same nodes: the column did not change');
  f.tree.select({ page: 'channel', id: 'まんぷく食堂' });
  assert.deepEqual([...f.host.querySelectorAll('.on')].map(node => node.textContent), ['まんぷく食堂']);
  assert.equal(f.host.querySelectorAll('[aria-current]').length, 1);
  f.tree.select({ page: 'shorts' });
  assert.deepEqual([...f.host.querySelectorAll('.on')].map(node => node.textContent), ['ショート']);
});

test('selection follows the route on first paint, and the ライブラリ root and 後で見る never both light up', t => {
  assert.deepEqual([...mount(t, { channels, signedIn: true }, { page: 'history' }).host.querySelectorAll('.on')].map(node => node.textContent), ['履歴']);
  const later = mount(t, { channels, signedIn: true }, { page: 'later' });
  assert.deepEqual([...later.host.querySelectorAll('.on')].map(node => node.textContent), ['あとで見る']);
  assert.equal(mount(t, { signedIn: true }, { page: 'nowhere' }).host.querySelectorAll('.on').length, 0);
});

test('channel rows take an avatar from the caller; the other rows take an icon', t => {
  const avatar = (document, channel) => { const span = document.createElement('span'); span.className = 'sidebar-avatar'; span.textContent = channel.name[0]; return span; };
  const f = mount(t, { channels, signedIn: true }, { page: 'home' }, { avatar });
  assert.equal(f.host.querySelectorAll('.sidebar-channel-row .sidebar-avatar').length, 3);
  assert.equal(f.host.querySelector('.sidebar-channel-row svg'), null);
  assert.ok(f.host.querySelector('[data-route="home"] svg.sidebar-icon'));
});

test('route helpers: id is part of identity', () => {
  assert.ok(sameRoute({ page: 'channel', id: 'a' }, { page: 'channel', id: 'a' }));
  assert.ok(!sameRoute({ page: 'channel', id: 'a' }, { page: 'channel', id: 'b' }));
  assert.ok(!sameRoute(null, { page: 'home' }));
  assert.equal(routeKey({ page: 'home' }), 'home');
});

test('フォロー中 branch lists followed profiles (type profile) and routes by handle, not by display name', t => {
  const followed = [{ type: 'profile', id: 'p1', handle: 'asa', name: '朝のテック', avatarUrl: null }, { type: 'profile', id: 'p2', handle: 'hiru', name: '昼の話', avatarUrl: null }];
  const f = mount(t, { channels: followed, signedIn: true });
  const kids = [...f.host.querySelectorAll('.sidebar-tree-children .sidebar-channel-row')];
  assert.deepEqual(kids.map(node => node.textContent), ['朝のテック', '昼の話']);
  kids[1].click();
  assert.deepEqual(f.gone, ['channel:hiru']);
  assert.equal(f.host.textContent.includes('登録'), false);
});
