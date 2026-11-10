import assert from 'node:assert/strict';
import test from 'node:test';
import { createMusicP2pDeclaration, P2P_CONFIRM, P2P_OFF, P2P_ON } from './music-p2p-declare.mjs';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950c';

function setup({ declared = [], confirmAnswer = true, failPrepare = false } = {}) {
  const calls = []; const notes = []; const asked = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === 'music_p2p_declared') return { ids: declared };
    if (name === 'music_p2p_prepare') { if (failPrepare) throw new Error('media_unavailable:attestation'); return { trackId: ID, revision: 4 }; }
    if (name === 'music_p2p_declare') { declared = [ID]; return {}; }
    if (name === 'music_p2p_withdraw') { declared = []; return {}; }
    throw new Error('unexpected');
  };
  const control = createMusicP2pDeclaration({ invoke, confirm: (t) => { asked.push(t); return confirmAnswer; }, notice: (t) => notes.push(t) });
  return { control, calls, notes, asked };
}
const names = (calls) => calls.map(([n]) => n);

test('off by default: only an eligible own track gets the control, others get none', async () => {
  const { control } = setup();
  await control.ready();
  assert.equal(control.label(ID, true), P2P_ON);
  assert.equal(control.label(ID, false), null);
  assert.equal(control.label('music:bad', true), null);
});

test('turning on fetches the attestation, asks for confirmation, then signs the confirmed revision', async () => {
  const { control, calls, asked } = setup();
  await control.run(ID);
  assert.deepEqual(names(calls).slice(0, 3), ['music_p2p_prepare', 'music_p2p_declare', 'music_p2p_declared']);
  assert.deepEqual(calls[1], ['music_p2p_declare', { trackId: ID, revision: 4 }]);
  assert.deepEqual(asked, [P2P_CONFIRM]);
  assert.equal(control.label(ID, true), P2P_OFF);
});

test('declining the confirmation signs nothing', async () => {
  const { control, calls } = setup({ confirmAnswer: false });
  await control.run(ID);
  assert.ok(!names(calls).includes('music_p2p_declare'));
});

test('turning off withdraws with an author tombstone; failures show a short notice', async () => {
  const on = setup({ declared: [ID] });
  await on.control.ready();
  assert.equal(on.control.label(ID, true), P2P_OFF);
  await on.control.run(ID);
  assert.ok(names(on.calls).includes('music_p2p_withdraw'));
  const bad = setup({ failPrepare: true });
  await bad.control.run(ID);
  assert.deepEqual(bad.notes, ['操作できませんでした。']);
  assert.ok(!names(bad.calls).includes('music_p2p_declare'));
});

test('the track menu shows the control only for own tracks and keeps it after the profile item', async () => {
  const { musicMenuItems } = await import('./music-track-menu.mjs');
  const base = { favorite() {}, addToPlaylist() {}, share() {}, report() {}, openExternal() {} };
  const labels = (items) => items.filter((i) => typeof i === 'object' && i).map((i) => i.label);
  const work = { id: `music:${ID}`, title: 'T' };
  assert.ok(!labels(musicMenuItems(work, base)).includes(P2P_ON));
  const withP2p = { ...base, p2p: { label: () => P2P_ON, run() {} }, profileAttribution: { label: () => 'プロフィールに表示', run() {} } };
  const shown = labels(musicMenuItems(work, withP2p));
  assert.equal(shown.at(-1), P2P_ON);
  assert.ok(!labels(musicMenuItems({ id: 'youtube:x', title: 'T' }, withP2p)).includes(P2P_ON));
});

test('autoSync publishes the stored documents and fetches followed authors once per period, quietly', async () => {
  const calls = [];
  let fail = false;
  const invoke = async (name) => {
    calls.push(name);
    if (name === 'music_p2p_declared') return { ids: [] };
    if (fail) throw new Error('desktop_not_connected');
    return {};
  };
  const control = createMusicP2pDeclaration({ invoke, confirm: () => true, notice: () => { throw new Error('no notice for background sync'); }, autoSync: true });
  await control.ready();
  await control.sync();
  assert.deepEqual(calls, ['music_p2p_declared', 'media_p2p_publish', 'media_p2p_fetch_declarations']);
  await control.sync();
  assert.equal(calls.length, 3, 'throttled within the period');
  const off = createMusicP2pDeclaration({ invoke: async (name) => { calls.push(`off:${name}`); return { ids: [] }; }, confirm: () => true });
  await off.ready();
  assert.ok(!calls.some((n) => n.startsWith('off:media_p2p_publish')), 'off unless asked for');
  fail = true;
  const failing = createMusicP2pDeclaration({ invoke, confirm: () => true, notice: () => { throw new Error('no notice'); }, autoSync: true });
  await failing.ready();
  await failing.sync();
});
