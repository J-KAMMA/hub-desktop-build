import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCommunityPoints, parseRanking, pointsLabel } from './community-points.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function rig(t, api) {
  const dom = new JSDOM('<main></main>'), document = dom.window.document, calls = [];
  const invoke = async (name, args) => { calls.push({ name, args }); return api(name, args); };
  const points = createCommunityPoints({ document, communityId: 'c-1', invoke });
  const main = document.querySelector('main'); main.append(points.own, ...points.toggle, points.ranking);
  t.after(() => dom.window.close());
  return { dom, document, calls, points, main, text: () => main.textContent, checkbox: () => main.querySelector('input[type=checkbox]') };
}
const member = (profileId, displayName, pts, handle = profileId) => ({ profileId, displayName, handle, points: pts });

test('own points are shown, the toggle starts off, and only opted-in members are listed', async (t) => {
  const r = rig(t, () => ({ enabled: true, points: 120, isPublic: false, members: [member('p-2', 'Bob', 300), member('p-3', 'Cy', 40)], nextCursor: null }));
  await r.points.ready;
  assert.deepEqual(r.calls, [{ name: 'hub_detail', args: { name: 'community_points_list', ids: ['c-1'] } }]);
  assert.match(r.text(), /あなたのポイント: 120点/);
  assert.equal(r.checkbox().checked, false);
  assert.match(r.text(), /ポイントを公開する/);
  const rows = [...r.main.querySelectorAll('.community-points-row')];
  assert.deepEqual(rows.map((row) => row.dataset.profileId), ['p-2', 'p-3']);
  assert.match(rows[0].textContent, /Bob.*300点/);
});

test('null points show a dash for the viewer and for a listed member', async (t) => {
  const r = rig(t, () => ({ enabled: true, points: null, isPublic: true, members: [member('p-2', 'Bob', null)], nextCursor: null }));
  await r.points.ready;
  assert.match(r.main.querySelector('.community-points-own').textContent, /あなたのポイント: —$/);
  assert.match(r.main.querySelector('.community-points-row').textContent, /Bob.*—$/);
  assert.equal(r.checkbox().checked, true);
  assert.equal(pointsLabel(null), '—');
  assert.equal(pointsLabel(0), '0点');
});

test('a community without points shows nothing and a failed read shows nothing', async (t) => {
  const none = rig(t, () => ({ enabled: false, points: null, isPublic: false }));
  await none.points.ready;
  assert.equal(none.points.own.hidden, true); assert.equal(none.points.ranking.hidden, true); assert.equal(none.points.toggle[0].hidden, true);
  const broken = rig(t, () => { throw Error('forbidden'); });
  await broken.points.ready;
  assert.equal(broken.points.own.hidden, true); assert.equal(broken.points.ranking.hidden, true);
});

test('turning the toggle on writes one boolean and then reads again; an unconfirmed write is undone', async (t) => {
  let isPublic = false;
  const r = rig(t, (name, args) => name === 'hub_client_action' ? { public: args.options.public } : { enabled: true, points: 5, isPublic, members: isPublic ? [member('p-1', 'Me', 5)] : [], nextCursor: null });
  await r.points.ready;
  isPublic = true;
  r.checkbox().checked = true; r.checkbox().dispatchEvent(new r.dom.window.Event('change'));
  await tick(); await tick();
  const write = r.calls.find((call) => call.name === 'hub_client_action');
  assert.deepEqual(write.args, { action: 'community_points_public', target: 'c-1', options: { public: true } });
  assert.equal(r.checkbox().checked, true);
  assert.equal(r.main.querySelectorAll('.community-points-row').length, 1);
  const bad = rig(t, (name) => name === 'hub_client_action' ? { public: false } : { enabled: true, points: 5, isPublic: false, members: [], nextCursor: null });
  await bad.points.ready;
  bad.checkbox().checked = true; bad.checkbox().dispatchEvent(new bad.dom.window.Event('change'));
  await tick(); await tick();
  assert.equal(bad.checkbox().checked, false); assert.match(bad.text(), /設定を変えられませんでした/);
});

test('paging appends the next ranking page by cursor without duplicates', async (t) => {
  const r = rig(t, (name, args) => args.name === 'community_points_list_page'
    ? { enabled: true, points: 1, isPublic: true, members: [member('p-2', 'Bob', 30), member('p-3', 'Cy', 20)], nextCursor: null }
    : { enabled: true, points: 1, isPublic: true, members: [member('p-1', 'Ann', 50), member('p-2', 'Bob', 30)], nextCursor: '30.p-2' });
  await r.points.ready;
  const more = [...r.main.querySelectorAll('button')].find((button) => button.textContent === 'さらに表示');
  assert.equal(more.hidden, false);
  more.click(); await tick(); await tick();
  assert.deepEqual(r.calls.at(-1).args, { name: 'community_points_list_page', ids: ['c-1', '30.p-2'] });
  assert.deepEqual([...r.main.querySelectorAll('.community-points-row')].map((row) => row.dataset.profileId), ['p-1', 'p-2', 'p-3']);
  assert.equal(more.hidden, true);
});

test('wallet addresses and other fields never reach the screen', async (t) => {
  const address = '0x' + 'a'.repeat(40);
  const r = rig(t, () => ({ enabled: true, points: 1, isPublic: true, wallet: address, members: [{ ...member('p-2', 'Bob', 3), address, wallet: address }], nextCursor: null }));
  await r.points.ready;
  assert.doesNotMatch(r.main.innerHTML, /0xa{40}/);
  assert.equal(Object.hasOwn(parseRanking({ enabled: true, points: 1, isPublic: true, members: [{ ...member('p-2', 'Bob', 3), address }] }).members[0], 'address'), false);
});

test('malformed responses are refused', () => {
  for (const bad of [null, [], { enabled: 'yes', points: 1, isPublic: false }, { enabled: true, points: -1, isPublic: false }, { enabled: true, points: 1.5, isPublic: false },
    { enabled: true, points: 1, isPublic: false, members: [{ profileId: 'a/b', displayName: 'x', handle: 'x', points: 1 }] },
    { enabled: true, points: 1, isPublic: false, members: [], nextCursor: '../x' }]) assert.throws(() => parseRanking(bad));
});
