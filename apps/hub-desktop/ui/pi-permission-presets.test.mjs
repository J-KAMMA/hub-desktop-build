import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PI_PERMISSION_PRESETS, createPiPermissionPresets, piPermissionPreset } from './pi-permission-presets.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
function fixture(t, { locked = false } = {}) {
  const dom = new JSDOM(`<body><button id="chip"><span id="label"></span></button><div id="pop" hidden>
    <button data-preset="ask"></button><button data-preset="write"></button><button data-preset="tools"></button><div id="custom" hidden></div>
    <div id="confirm" hidden><button id="ok"></button><button id="no"></button></div><p id="lock" hidden></p>
    <input id="program"><div id="warn" hidden><button id="enable"></button></div>
    <input id="w" type="checkbox"><input id="e" type="checkbox"><input id="h" type="checkbox"></div></body>`);
  const d = dom.window.document, el = id => d.getElementById(id), state = { locked };
  const presets = createPiPermissionPresets(d, { chip: el('chip'), chipLabel: el('label'), popover: el('pop'),
    checkboxes: { write: el('w'), exec: el('e'), http: el('h') }, presetButtons: [...d.querySelectorAll('button[data-preset]')], customRow: el('custom'),
    confirmBox: el('confirm'), confirmOk: el('ok'), confirmCancel: el('no'), lockNote: el('lock'), verifyProgram: el('program'), verifyWarning: el('warn'), verifyEnable: el('enable'), isLocked: () => state.locked });
  t.after(() => { presets.destroy(); dom.window.close(); });
  const flags = () => [el('w').checked, el('e').checked, el('h').checked];
  return { dom, d, el, presets, state, flags };
}
test('each preset maps to its checkbox states and any other combination is custom', () => {
  assert.deepEqual(PI_PERMISSION_PRESETS.map(p => [p.id, p.write, p.exec, p.http]), [['ask', false, false, false], ['write', true, false, false], ['tools', false, true, true]]);
  for (const p of PI_PERMISSION_PRESETS) assert.equal(piPermissionPreset(p), p.id);
  for (const [write, exec, http] of [[true, true, false], [false, true, false], [false, false, true], [true, false, true], [true, true, true]]) assert.equal(piPermissionPreset({ write, exec, http }), 'custom');
});
test('there is no full-access preset', () => {
  assert.equal(PI_PERMISSION_PRESETS.some(p => p.write && p.exec && p.http), false);
});
test('choosing tools sets exec and http only; choosing ask clears them; chip label follows', t => {
  const f = fixture(t);
  assert.equal(f.el('label').textContent, '都度承認');
  assert.equal(f.presets.choose('tools'), 'applied'); assert.deepEqual(f.flags(), [false, true, true]); assert.equal(f.el('label').textContent, 'コマンドと通信を使う');
  assert.equal(f.d.querySelector('[data-preset=tools]').getAttribute('aria-checked'), 'true');
  assert.equal(f.presets.choose('ask'), 'applied'); assert.deepEqual(f.flags(), [false, false, false]);
});
test('write needs the inline confirm and does not change anything until 許可する', t => {
  const f = fixture(t);
  assert.equal(f.presets.choose('write'), 'confirm'); assert.deepEqual(f.flags(), [false, false, false]); assert.equal(f.el('confirm').hidden, false);
  f.el('no').click(); assert.equal(f.el('confirm').hidden, true); assert.deepEqual(f.flags(), [false, false, false]);
  f.d.querySelector('[data-preset=write]').click(); assert.equal(f.el('confirm').hidden, false);
  f.el('ok').click(); assert.deepEqual(f.flags(), [true, false, false]); assert.equal(f.el('confirm').hidden, true); assert.equal(f.el('label').textContent, '書き込みを許可');
  assert.equal(f.presets.confirmWrite(), 'locked', 'a second confirm without a pending prompt does nothing');
  f.presets.choose('tools'); assert.deepEqual(f.flags(), [false, true, true], 'switching away turns the write grant off without a confirm');
});
test('manual checkbox combinations show カスタム as display only', t => {
  const f = fixture(t);
  f.el('e').checked = true; f.el('e').dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(f.el('label').textContent, 'カスタム'); assert.equal(f.el('custom').hidden, false);
  assert.equal(f.presets.choose('custom'), 'locked');
});
test('presets cannot change while locked and the lock note is shown', t => {
  const f = fixture(t, { locked: true }); f.presets.sync();
  assert.equal(f.presets.choose('tools'), 'locked'); assert.equal(f.presets.choose('write'), 'locked'); assert.deepEqual(f.flags(), [false, false, false]);
  assert.equal(f.el('lock').hidden, false); assert.equal(f.el('lock').textContent, '作業中は変更できません');
  assert.equal([...f.d.querySelectorAll('button[data-preset]')].every(b => b.disabled), true);
});
test('a pending write confirm is dropped when a run locks the presets', t => {
  const f = fixture(t); f.presets.choose('write'); f.state.locked = true; f.presets.sync();
  assert.equal(f.el('confirm').hidden, true); assert.equal(f.presets.confirmWrite(), 'locked'); assert.deepEqual(f.flags(), [false, false, false]);
});
test('a verifier without command execution shows the warning and offers the tools preset', t => {
  const f = fixture(t);
  f.el('program').value = 'node'; f.el('program').dispatchEvent(new f.dom.window.Event('input')); assert.equal(f.el('warn').hidden, false);
  f.el('enable').click(); assert.deepEqual(f.flags(), [false, true, true]); assert.equal(f.el('warn').hidden, true);
});
test('chip opens the popover and Escape closes it', t => {
  const f = fixture(t);
  f.el('chip').click(); assert.equal(f.el('pop').hidden, false);
  f.d.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(f.el('pop').hidden, true);
});
