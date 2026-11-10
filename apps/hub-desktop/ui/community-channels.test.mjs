import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createChannelColumn, createSharedTab, hiddenUpdate, loadChannels, moveUpdate, parseChannels, pickChannel, renameUpdate, shownChannels } from './community-channels.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const doc = () => new JSDOM('<main></main>').window.document;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const three = [{ kind: 'chat', name: '雑談', hidden: false }, { kind: 'question', name: '質問', hidden: false }, { kind: 'party', name: '募集', hidden: false }];

test('parseChannels keeps known kinds once, drops bad rows, and falls back to the three defaults', () => {
  assert.equal(parseChannels(null).channels.length, 3);
  assert.equal(parseChannels({ channels: [] }).channels.length, 3);
  const parsed = parseChannels({ channels: [{ kind: 'party', name: 'ぼしゅう' }, { kind: 'party', name: 'dup' }, { kind: 'guide', name: 'x' }, { kind: 'chat', name: '' }, { kind: 'question', name: 'q', hidden: true }], canManage: true });
  assert.deepEqual(parsed.channels.map((c) => [c.kind, c.hidden]), [['party', false], ['question', true]]);
  assert.equal(parsed.canManage, true);
  assert.equal(parseChannels({ channels: three }).canManage, false);
});

test('pickChannel keeps the choice while shown and otherwise takes the first shown channel', () => {
  const channels = [{ kind: 'chat', name: 'a', hidden: true }, { kind: 'question', name: 'b', hidden: false }, { kind: 'party', name: 'c', hidden: false }];
  assert.equal(pickChannel(channels, 'party').kind, 'party');
  assert.equal(pickChannel(channels, 'chat').kind, 'question');
  assert.equal(pickChannel([{ kind: 'chat', name: 'a', hidden: true }], 'chat'), null);
  assert.equal(shownChannels(channels).length, 2);
});

test('update shapes match the server: rename, hidden, and a complete order', () => {
  assert.deepEqual({ ...renameUpdate('chat', 'x') }, { kind: 'chat', name: 'x' });
  assert.deepEqual({ ...hiddenUpdate('chat', true) }, { kind: 'chat', hidden: true });
  assert.deepEqual(moveUpdate(three, 'chat', 1).order, ['question', 'chat', 'party']);
  assert.equal(moveUpdate(three, 'chat', -1), null);
  assert.equal(moveUpdate(three, 'party', 1), null);
});

test('the column selects once per change and shows # names', () => {
  const document = doc(), picked = [];
  const column = createChannelColumn({ document, channels: three, selected: 'chat', onSelect: (kind) => picked.push(kind) });
  const buttons = [...column.root.querySelectorAll('.community-channel')];
  assert.deepEqual(buttons.map((b) => b.textContent), ['#雑談', '#質問', '#募集']);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  buttons[1].click(); buttons[1].click();
  assert.deepEqual(picked, ['question']);
  assert.equal(column.selected, 'question');
  assert.equal(column.root.querySelector('.community-channel-manage'), null);
});

test('a moderator renames (prompt), hides and restores; the selection moves off a hidden channel', async () => {
  const document = doc(), sent = [], picked = [];
  let channels = three;
  const column = createChannelColumn({
    document, channels, canManage: true, selected: 'chat', onSelect: (kind) => picked.push(kind), prompt: () => '  ざつだん ',
    onManage: async (update) => { sent.push(update); if ('hidden' in update) channels = channels.map((c) => c.kind === update.kind ? { ...c, hidden: update.hidden } : c); if ('name' in update) channels = channels.map((c) => c.kind === update.kind ? { ...c, name: update.name } : c); return { channels }; },
  });
  column.root.querySelector('.community-channel-manage').click();
  const row = (kind) => column.root.querySelector(`.community-channel-row[data-kind="${kind}"]`);
  row('chat').querySelector('[aria-label="名前を変える"]').click(); await tick();
  assert.deepEqual({ ...sent[0] }, { kind: 'chat', name: 'ざつだん' });
  assert.equal(row('chat').querySelector('.community-channel').textContent, '#ざつだん');
  row('chat').querySelector('[aria-label="隠す"]').click(); await tick();
  assert.deepEqual(picked, ['question']);
  assert.equal(column.selected, 'question');
  assert.equal(row('chat').classList.contains('is-hidden'), true);
  row('chat').querySelector('[aria-label="戻す"]').click(); await tick();
  assert.equal(row('chat').classList.contains('is-hidden'), false);
  column.root.querySelector('.community-channel-manage').click();
  assert.equal(column.root.querySelectorAll('.community-channel-tools').length, 0);
});

test('a failed management call shows the server message and keeps the list', async () => {
  const document = doc();
  const column = createChannelColumn({ document, channels: three, canManage: true, selected: 'chat', onManage: async () => { throw Error('最後のチャンネルは隠せません。'); } });
  column.root.querySelector('.community-channel-manage').click();
  column.root.querySelector('[aria-label="隠す"]').click(); await tick();
  assert.match(column.root.querySelector('[role="status"]').textContent, /最後のチャンネル/);
  assert.equal(column.root.querySelectorAll('.community-channel').length, 3);
});

test('loadChannels asks the fixed detail name and never throws', async () => {
  const calls = [];
  const ok = await loadChannels(async (name, args) => { calls.push([name, args]); return { channels: three, canManage: true }; }, 'c1');
  assert.deepEqual(calls, [['hub_detail', { name: 'community_channels', ids: ['c1'] }]]);
  assert.equal(ok.canManage, true);
});

test('shared tab: one list at a time, switching disposes the previous list; guides use the post stream', () => {
  const document = doc(), made = [], disposed = [], guides = [], kinds = [];
  const tab = createSharedTab({
    document, onKind: (kind) => kinds.push(kind),
    createContentTabs: (type) => { made.push(type); const root = document.createElement('div'); root.dataset.type = type; return { root, ready: Promise.resolve(), dispose() { disposed.push(type); } }; },
    mountGuides: (host) => { guides.push(host); return { dispose() { disposed.push('guide'); } }; },
  });
  assert.deepEqual([...tab.root.querySelectorAll('.community-shared-kinds button')].map((b) => b.textContent), ['記事', '動画', '音楽', '共同ページ']);
  assert.deepEqual(made, ['article']);
  const chip = (kind) => tab.root.querySelector(`.community-shared-kinds [data-kind="${kind}"]`);
  chip('music').click();
  assert.deepEqual(made, ['article', 'music']);
  assert.equal(tab.root.querySelectorAll('.community-shared-body > *').length, 1);
  chip('guide').click();
  assert.equal(guides.length, 1);
  assert.equal(chip('guide').getAttribute('aria-pressed'), 'true');
  chip('guide').click();
  assert.equal(guides.length, 1);
  assert.deepEqual(disposed, ['article', 'music']);
  assert.deepEqual(kinds, ['music', 'guide']);
  tab.dispose();
  assert.equal(disposed.at(-1), 'guide');
});
