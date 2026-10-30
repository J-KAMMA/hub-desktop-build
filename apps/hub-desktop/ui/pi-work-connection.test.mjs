import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionChoices, connectionModelRef } from './pi-work-connection.mjs';
import { buildPiWorkRequest } from './pi-work.mjs';

const ID = '0f8c2a2e-5b1d-4c3e-9a7b-1234567890ab';

test('the picker lists only well-formed configured connections and never a key', () => {
  const choices = connectionChoices([
    { id: ID, name: ' hub-bench ', kind: 'anthropic', defaultModel: 'claude-haiku-5-5', apiKey: 'sk-should-not-pass' },
    { id: 'not-a-uuid', name: 'x' },
    { id: ID.replace('0f', '1f'), name: '' },
    { id: ID.replace('0f', '2f'), name: 'local', defaultModel: 'bad model' },
    null,
  ]);
  assert.deepEqual(choices, [
    { id: ID, name: 'hub-bench', defaultModel: 'claude-haiku-5-5' },
  ].concat([{ id: ID.replace('0f', '2f'), name: 'local', defaultModel: '' }]));
  assert.ok(!JSON.stringify(choices).includes('sk-'));
  assert.deepEqual(connectionChoices('nope'), []);
});

test('a chosen connection becomes the run model; an empty model means its default', () => {
  assert.equal(connectionModelRef('', 'x'), null);
  assert.equal(connectionModelRef(ID, ''), `byok:${ID}/`);
  assert.equal(connectionModelRef(ID, 'claude-sonnet-5'), `byok:${ID}/claude-sonnet-5`);
  assert.throws(() => connectionModelRef('bad', ''), /AIの接続/);
  assert.throws(() => connectionModelRef(ID, 'a b'), /モデル名/);
  assert.throws(() => connectionModelRef(ID, 'a..b'), /モデル名/);
});

test('pi_work_start uses the connection model and keeps every permission flag as chosen', () => {
  const request = buildPiWorkRequest({ workspace: 'C:/w', prompt: 'fix it', model: 'ollama/qwen', connection: ID, connectionModel: '' });
  assert.equal(request.model, `byok:${ID}/`);
  assert.deepEqual([request.allowWrite, request.allowExec, request.allowHttp], [false, false, false]);
  assert.equal(buildPiWorkRequest({ workspace: 'C:/w', prompt: 'fix it', model: 'ollama/qwen' }).model, 'ollama/qwen');
});
