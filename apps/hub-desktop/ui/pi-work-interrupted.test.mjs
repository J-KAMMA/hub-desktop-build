import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeInterrupted, compactionNote, interruptedPanel } from './pi-work-interrupted.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const document = new JSDOM('').window.document;

test('normalizeInterrupted keeps only well-formed sessions keyed by runId', () => {
  const map = normalizeInterrupted([{ runId: 'a', interrupted: [{ callId: 'c', name: 'hub_write' }], pendingApprovals: [{ id: 'p', tool: 'hub_exec', summary: 's' }] }, { runId: '' }, null, 'x']);
  assert.deepEqual([...map.keys()], ['a']);
  assert.equal(map.get('a').interrupted[0].name, 'hub_write');
  assert.equal(map.get('a').approvals[0].tool, 'hub_exec');
  assert.equal(normalizeInterrupted(undefined).size, 0);
});

test('compactionNote is a single status line and ignores unknown phases', () => {
  assert.equal(compactionNote(document, null), null);
  assert.equal(compactionNote(document, { phase: 'x', line: 'a' }), null);
  const note = compactionNote(document, { phase: 'running', line: '会話を要約しています' });
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(note.textContent, '会話を要約しています');
});

test('interruptedPanel disables both actions while busy and has no approve control', () => {
  const item = normalizeInterrupted([{ runId: 'a', pendingApprovals: [{ id: 'p', tool: 'hub_pay', summary: '' }] }]).get('a');
  const calls = [];
  const busy = interruptedPanel({ document, item, busy: true, onRerun: () => calls.push('r'), onDismiss: () => calls.push('d') });
  busy.querySelector('.piw-interrupted-rerun').click(); busy.querySelector('.piw-interrupted-dismiss').click();
  assert.deepEqual(calls, []);
  const ready = interruptedPanel({ document, item, onRerun: () => calls.push('r'), onDismiss: () => calls.push('d') });
  ready.querySelector('.piw-interrupted-rerun').click(); ready.querySelector('.piw-interrupted-dismiss').click();
  assert.deepEqual(calls, ['r', 'd']);
  assert.equal(ready.querySelector('.approve'), null);
});
