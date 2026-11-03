import assert from 'node:assert/strict';
import test from 'node:test';
import { attributionMessage, commerceProofFetcher, createProfileAttribution, musicProofFetcher } from './profile-attribution.mjs';

const CHALLENGE = 'AAAAAAAAAAAAAAAAAAAAAA';

function setup(fetchProof) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (args?.action === 'attribution_challenge') return { challenge: CHALLENGE };
    if (args?.name === 'attribution_market') return { ids: ['p1', 7] };
    return {};
  };
  return { calls, api: createProfileAttribution({ invoke, fetchProof }) };
}

test('show asks Hub for a challenge, gets a proof directly, then posts only the proof to Hub', async () => {
  const seen = [];
  const { api, calls } = setup({ market: async (id, challenge) => { seen.push([id, challenge]); return 'a.b.c'; } });
  await api.show('market', 'p1');
  assert.deepEqual(seen, [['p1', CHALLENGE]]);
  assert.deepEqual(calls.map(([command, args]) => [command, args.action, args.target, args.options]), [
    ['hub_client_action', 'attribution_challenge', 'market', undefined],
    ['hub_client_action', 'attribution_claim', 'market', { proof: 'a.b.c' }],
  ]);
});

test('a kind without a proof path is unsupported and never contacts Hub', async () => {
  const { api, calls } = setup({});
  assert.equal(api.supports('music'), false);
  await assert.rejects(api.show('music', 'x'), /attribution_unsupported/u);
  assert.equal(calls.length, 0);
});

test('rejects a malformed challenge and an empty proof before posting', async () => {
  const bad = createProfileAttribution({ invoke: async () => ({ challenge: 'short' }), fetchProof: { market: async () => 'a.b.c' } });
  await assert.rejects(bad.show('market', 'p'), /invalid_attribution_challenge/u);
  const { api, calls } = setup({ market: async () => '' });
  await assert.rejects(api.show('market', 'p'), /invalid_attribution_proof/u);
  assert.equal(calls.some(([, args]) => args.action === 'attribution_claim'), false);
});

test('remove sends the id under the kind-specific key; ids filters non-strings', async () => {
  const { api, calls } = setup({});
  await api.remove('music', 't1');
  await api.remove('market', 'p1');
  assert.deepEqual(calls.map(([, args]) => args.options), [{ trackId: 't1' }, { productId: 'p1' }]);
  assert.deepEqual(await api.ids('market'), ['p1']);
  await assert.rejects(api.remove('video', 'x'), /invalid_purpose/u);
});

test('commerce fetcher uses the seller command and returns the proof string', async () => {
  const calls = [];
  const proof = await commerceProofFetcher(async (command, args) => { calls.push([command, args]); return { proof: 'x.y.z' }; })('p1', CHALLENGE);
  assert.equal(proof, 'x.y.z');
  assert.deepEqual(calls, [['commerce_seller_attribution_proof', { productId: 'p1', challenge: CHALLENGE }]]);
});

test('messages map known errors and hide everything else', () => {
  assert.match(attributionMessage(new Error('already_attributed')), /ほかのプロフィール/u);
  assert.match(attributionMessage('boom stack trace'), /更新できませんでした/u);
});

test('music fetcher uses the Rust command with only the track id and challenge, and shows through the full flow', async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'music_attribution_proof') return { proof: 'x.y.z' };
    if (args?.action === 'attribution_challenge') return { challenge: CHALLENGE };
    return {};
  };
  const api = createProfileAttribution({ invoke, fetchProof: { music: musicProofFetcher(invoke) } });
  assert.equal(api.supports('music'), true);
  const id = '11111111-1111-4111-8111-111111111111';
  await api.show('music', id);
  assert.deepEqual(calls[1], ['music_attribution_proof', { trackId: id, challenge: CHALLENGE }]);
  assert.deepEqual(calls[2], ['hub_client_action', { action: 'attribution_claim', target: 'music', options: { proof: 'x.y.z' } }]);
  assert.equal(JSON.stringify(calls).includes('assertion'), false);
});

test('music link and eligibility errors have their own plain messages', () => {
  assert.match(attributionMessage('music_link_required'), /Music/u);
  assert.match(attributionMessage('track_not_eligible'), /公開中/u);
});

test('app.js wires the music menu to the Rust commands and the own-tracks gate', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /music: musicProofFetcher\(invoke\)/u);
  assert.match(source, /invoke\("music_own_attribution_candidates"\)/u);
  assert.match(source, /musicAttributionState\.eligible\.has\(id\) \? "プロフィールに表示" : null/u);
  assert.match(source, /"プロフィールから外す"/u);
  assert.doesNotMatch(source, /Music の管理認証が未対応/u);
});
