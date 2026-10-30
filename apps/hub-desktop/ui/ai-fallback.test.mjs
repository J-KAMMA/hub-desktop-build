import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runChain, decide, createByokStarter } from './ai-fallback.mjs';
import { resolveChain, loadRules, saveRules, normalizeRules, ROUTING_KEY } from './ai-routing.mjs';
import { privacyFor, privacyLabel, PRIVACY_TABLE } from './ai-provider-privacy.mjs';
import { parseRef } from './byok-chat.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const A = `byok:${ID}/a`, B = `byok:${ID}/b`, C = 'cli:claude/default', L = 'local:model', P = 'pc:host';

/** script[ref] = (sink) => void。呼ばれた順を calls に残す。 */
function harness(script, opts = {}) {
  const calls = [], log = { switches: [], deltas: [], done: null, error: null };
  const timers = [];
  const run = runChain({
    entries: opts.entries ?? [A, B, C], refusalFallback: opts.refusalFallback,
    firstTokenMs: 1000,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; }, clearTimer: (i) => { timers[i] = null; },
    start: async (ref, sink) => { calls.push(ref); script[ref]?.(sink); return () => {}; },
    on: { switch: (s) => log.switches.push(s), delta: (t, r) => log.deltas.push([t, r]), done: (d) => { log.done = d; }, error: (c, f) => { log.error = [c, f]; } },
  });
  return { calls, log, run, timers };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

test('falls back in the user order on error / rate limit / timeout', async () => {
  const h = harness({
    [A]: (s) => s.error('byok_rate_limited'),
    [B]: () => {}, // 無応答 → タイムアウト
    [C]: (s) => { s.delta('こんにちは'); s.done(false); },
  });
  await settle();
  assert.deepEqual(h.calls, [A, B]);
  h.timers.filter(Boolean).forEach((fn) => fn());
  await settle();
  assert.deepEqual(h.calls, [A, B, C]);
  assert.deepEqual(h.log.deltas, [['こんにちは', C]]);
  assert.equal(h.log.done.answeredBy, C);
  assert.deepEqual(h.log.switches.map((s) => [s.ref, s.reason]), [[A, null], [B, 'byok_rate_limited'], [C, 'byok_timeout']]);
});

test('no fallback once the first token has streamed', async () => {
  const h = harness({ [A]: (s) => { s.delta('途中'); s.error('byok_connection_lost'); } });
  await settle();
  assert.deepEqual(h.calls, [A]);
  assert.equal(h.log.error[0], 'byok_connection_lost');
  assert.equal(h.log.done, null);
});

test('content-policy refusal stops the chain unless the user enabled it', async () => {
  const s1 = harness({ [A]: (s) => s.error('byok_blocked'), [B]: (s) => { s.delta('x'); s.done(); } });
  await settle();
  assert.deepEqual(s1.calls, [A]); assert.equal(s1.log.error[0], 'byok_blocked');
  const s2 = harness({ [A]: (s) => s.error('byok_blocked'), [B]: (s) => { s.delta('x'); s.done(); } }, { refusalFallback: true });
  await settle();
  assert.deepEqual(s2.calls, [A, B]); assert.equal(s2.log.done.answeredBy, B);
  assert.equal(decide('byok_response_too_large'), 'stop');
});

test('all failing reports codes and refs only; empty replies count as failure', async () => {
  const h = harness({ [A]: (s) => s.done(false), [B]: (s) => s.error('byok_auth_failed') }, { entries: [A, B] });
  await settle();
  assert.deepEqual(h.log.error[1], [{ ref: A, code: 'byok_provider_failed' }, { ref: B, code: 'byok_auth_failed' }]);
});

test('local, PC and other-hub endpoints sit in the same ordered list', async () => {
  const h = harness({ [L]: (s) => s.error('byok_unreachable'), [P]: (s) => s.error('byok_timeout'), [A]: (s) => { s.delta('ok'); s.done(); } }, { entries: [L, P, A] });
  await settle();
  assert.deepEqual(h.calls, [L, P, A]);
});

test('routing: per-task order, filtered by availability, stored locally as refs only', () => {
  const rules = normalizeRules({ chain: [A, B], tasks: { code: [C, A, 'junk', A], bogus: [B] }, refusalFallback: true });
  assert.deepEqual(rules.tasks, { code: [C, A] });
  assert.deepEqual(resolveChain(rules, 'code', [A, C]), [C, A]);
  assert.deepEqual(resolveChain(rules, 'code', [A]), [A]);
  assert.deepEqual(resolveChain(rules, 'chat', [A, B, C]), [A, B]);
  assert.deepEqual(resolveChain(rules, 'nope', [B]), [B]);
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(saveRules(storage, rules), true);
  assert.deepEqual(loadRules(storage), rules);
  assert.equal(loadRules({ getItem: () => '{bad' }).chain.length, 0);
  assert.ok(store.has(ROUTING_KEY));
});

test('no key or conversation leaks to storage, logs or UI text', async () => {
  const SECRET = 'sk-SECRET-1234567890', PROMPT = 'ひみつの質問';
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => logged.push(a.join(' '));
  try {
    saveRules(storage, { chain: [A, `byok:${ID}/${'m'}`], tasks: {} });
    const invoke = async (name) => (name === 'byok_chat_start' ? 'r1' : null);
    let cb;
    const start = createByokStarter({ invoke, listen: async (_n, f) => { cb = f; return () => {}; }, parseRef, messages: [{ role: 'user', content: PROMPT }] });
    const h = { got: [] };
    runChain({ entries: [A], start, on: { delta: (t) => h.got.push(t), error: (c, f) => h.got.push(JSON.stringify([c, f])) } });
    await settle();
    cb({ payload: { requestId: 'r1', type: 'error', code: `byok_auth_failed ${SECRET}` } });
    await settle();
  } finally { Object.assign(console, orig); }
  assert.equal(logged.length, 0);
  for (const v of store.values()) { assert.ok(!v.includes(SECRET) && !v.includes(PROMPT)); }
  for (const f of ['ai-fallback.mjs', 'ai-routing.mjs', 'ai-provider-privacy.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /console\.|localStorage|sessionStorage|apiKey|api_key/, f);
  }
});

test('privacy labels: sourced, dated, unknowns stay 未確認', () => {
  for (const [k, p] of Object.entries(PRIVACY_TABLE)) {
    assert.ok(p.sources.length > 0 && p.sources.every((u) => u.startsWith('https://')), k);
    assert.equal(p.checkedOn, '2026-10-30');
    for (const f of ['training', 'retention', 'optOut', 'region']) {
      assert.ok(p[f].length > 0, `${k}.${f}`);
      // 確認済みの値には項目ごとの出典URLが要る。
      if (p[f] !== '未確認') assert.ok(String(p.fieldSources[f]).startsWith('https://'), `${k}.${f} source`);
    }
  }
  assert.match(privacyLabel('anthropic'), /学習利用: 商用プロダクト/);
  assert.equal(privacyFor('openai_compatible', { baseUrl: 'http://localhost:8080' }).training, '送信しない');
  assert.equal(privacyFor('openai_compatible', { baseUrl: 'https://hub.example.org/v1' }).retention, '未確認');
  assert.equal(privacyFor('mystery').training, '未確認');
});

import { createRequire } from 'node:module';
import { createConnectionChat, createConnectionModels, apiRef } from './byok-chat.mjs';
import { createAiRoutingPanel } from './ai-routing-panel.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

test('chat send falls back before the first token and labels who answered; panel saves refs only', async () => {
  const dom = new JSDOM('<div class="piw-shell"><div class="piw-timeline-wrap"><div id="t"></div></div></div>'), document = dom.window.document;
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const R1 = apiRef(ID, 'a'), R2 = apiRef(ID, 'b');
  saveRules(storage, { chain: [R1, R2] });
  const handlers = []; let n = 0;
  const invoke = async (name) => (name === 'byok_chat_start' ? `q${++n}` : null);
  const listen = async (_x, cb) => { handlers.push(cb); return () => {}; };
  const host = document.querySelector('.piw-timeline-wrap');
  const chat = createConnectionChat({ document, invoke, listen, host, timeline: document.querySelector('#t'),
    routing: { storage, available: () => new Set([R1, R2]), nameOf: (r) => (r === R1 ? 'P1' : 'P2') } });
  assert.equal(await chat.send('質問', R1), true);
  await settle();
  handlers.forEach((h) => h({ payload: { requestId: 'q1', type: 'error', code: 'byok_rate_limited' } }));
  await settle();
  assert.match(host.querySelector('.byok-status').textContent, /P1 が使えなかった.*P2/);
  handlers.forEach((h) => h({ payload: { requestId: 'q2', type: 'delta', text: 'やあ' } }));
  handlers.forEach((h) => h({ payload: { requestId: 'q2', type: 'done' } }));
  await settle();
  assert.equal(host.querySelector('.byok-assistant').textContent, 'やあ');
  assert.match(host.querySelector('.byok-answered').textContent, /回答: P2.*切り替え/);
  assert.equal(chat.isBusy(), false);

  const panel = createAiRoutingPanel({ document, storage, invoke: async () => ({ sources: [{ kind: 'api', id: ID, name: 'X', models: ['a', 'b'] }] }) });
  await panel.refresh();
  const sel = panel.element.querySelector('select'); sel.value = apiRef(ID, 'a'); sel.dispatchEvent(new dom.window.Event('change'));
  const sw = panel.element.querySelector('input[role=switch]'); sw.checked = true; sw.dispatchEvent(new dom.window.Event('change'));
  const saved = JSON.parse(store.get(ROUTING_KEY));
  assert.equal(saved.refusalFallback, !loadRules({ getItem: () => null }).refusalFallback);
  assert.ok(saved.chain.every((r) => r.startsWith('byok:')));
  const models = createConnectionModels({ invoke: async (c) => (c === 'byok_models' ? { sources: [{ kind: 'api', id: ID, name: 'X', provider: 'openai', models: ['a'] }] } : { models: [] }) });
  await models.invoke('pi_work_models', {});
  assert.match(models.privacyOf(apiRef(ID, 'a')), /学習利用: API に送ったデータ/);
});
