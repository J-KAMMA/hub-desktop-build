import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiRuntimeAdapter } from './pi-adapter.mjs';
import { createDshSession } from './hub-runtime.mjs';

const model = () => ({ provider: 'fixture', id: 'tiny', name: 'Fixture', contextWindow: 8192, maxTokens: 2048, reasoning: true,
  thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } });
const request = (extra = {}) => ({ provider: 'fixture', model: 'tiny', messages: [
  { role: 'system', content: [{ type: 'text', text: 'Fixture system' }] },
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture user' }] },
], tools: [], ...extra });
const answer = () => ({ role: 'assistant', content: [{ type: 'text', text: 'FIXTURE_OK' }], provider: 'fixture', model: 'tiny', stopReason: 'stop',
  usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 } });
function fixture(selected = model(), response = answer()) {
  const calls = [];
  const runtime = { streamSimple(model, context, options) { calls.push({ model, context, options }); const stream = (async function* () {})(); stream.result = async () => response; return stream; } };
  return { calls, runtime, model: selected, adapter: new PiRuntimeAdapter(selected, runtime, undefined, undefined, 'fixed-native-session') };
}
const collect = async iterable => { const result = []; for await (const value of iterable) result.push(value); return result; };

test('forwards temperature/maxTokens/actual DSH reasoningEffort as Pi reasoning, preserving the model/context/abort/session routes', async () => {
  const { adapter, calls, model } = fixture(), controller = new AbortController();
  const tools = [{ name: 'hub_read', description: 'Fixture', parameters: { type: 'object' } }];
  const chunks = await collect(adapter.stream(request({ tools, signal: controller.signal, temperature: 0.7, maxTokens: 512, reasoningEffort: 'high', sessionId: 'dsh-envelope-session' })));
  assert.equal(calls.length, 1); assert.equal(calls[0].model, model); assert.equal(calls[0].context.tools, tools);
  assert.equal(calls[0].context.systemPrompt, 'Fixture system'); assert.equal(calls[0].context.messages[0].role, 'user');
  assert.deepEqual(calls[0].options, { signal: controller.signal, sessionId: 'fixed-native-session', maxTokens: 512, temperature: 0.7, reasoning: 'high' });
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.equal(chunks.at(-1).replayState.response.pi.content[0].text, 'FIXTURE_OK');
});
test('undefined settings preserve prior model token cap and provider defaults, including a constructor-generated session ID', async () => {
  const { runtime, calls, model } = fixture(); const adapter = new PiRuntimeAdapter(model, runtime);
  await collect(adapter.stream(request({ temperature: undefined, maxTokens: undefined, reasoningEffort: undefined, stop: undefined, system: undefined, purpose: undefined })));
  assert.equal(calls[0].options.maxTokens, model.maxTokens); assert.match(calls[0].options.sessionId, /^[0-9a-f-]{36}$/u);
  assert.equal(calls[0].options.sessionId, adapter.sessionId); assert.equal(Object.hasOwn(calls[0].options, 'temperature'), false); assert.equal(Object.hasOwn(calls[0].options, 'reasoning'), false);
});
test('model resolution advertises exactly SDK-supported Pi levels, without inventing off or a reasoning default', async () => {
  const base = model(); delete base.thinkingLevelMap;
  const { adapter } = fixture(base); const resolved = await adapter.resolveModel(base.provider, base.id);
  assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.id), ['minimal', 'low', 'medium', 'high']); assert.equal(Object.hasOwn(resolved.reasoning, 'defaultEffort'), false);
  base.thinkingLevelMap = { high: null, xhigh: 'extra', max: 'maximum' };
  assert.deepEqual((await adapter.resolveModel(base.provider, base.id)).reasoning.efforts.map(effort => effort.id), ['minimal', 'low', 'medium', 'xhigh', 'max']);
  base.reasoning = false; assert.equal((await adapter.resolveModel(base.provider, base.id)).reasoning, undefined);
});
test('supported efforts reach options unchanged, while off/unknown/disabled levels fail before runtime', async () => {
  for (const reasoningEffort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) { const { adapter, calls } = fixture(); await collect(adapter.stream(request({ reasoningEffort }))); assert.equal(calls[0].options.reasoning, reasoningEffort); }
  for (const reasoningEffort of ['off', 'ultra', '', 1, null, {}]) { const { adapter, calls } = fixture(); await assert.rejects(collect(adapter.stream(request({ reasoningEffort }))), { message: 'dsh_request_settings_invalid' }); assert.equal(calls.length, 0); }
  const selected = model(); selected.thinkingLevelMap.high = null;
  for (const selectedModel of [selected, { ...model(), reasoning: false }]) { const { adapter, calls } = fixture(selectedModel); await assert.rejects(collect(adapter.stream(request({ reasoningEffort: 'high' }))), { message: 'dsh_request_settings_invalid' }); assert.equal(calls.length, 0); }
});
test('valid temperature/token bounds are explicit, with no coercion, token clamp or silent invalid-value ignore', async () => {
  for (const temperature of [0, -0, 0.5, 2]) { const { adapter, calls } = fixture(); await collect(adapter.stream(request({ temperature }))); assert.equal(calls[0].options.temperature, temperature); }
  for (const maxTokens of [1, 2048]) { const { adapter, calls } = fixture(); await collect(adapter.stream(request({ maxTokens }))); assert.equal(calls[0].options.maxTokens, maxTokens); }
  for (const [key, values] of [['temperature', [-1, 2.01, NaN, Infinity, -Infinity, '0.5', null, false, {}]], ['maxTokens', [0, -1, 2049, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '512', null, false, {}]]]) {
    for (const value of values) { const { adapter, calls } = fixture(); await assert.rejects(collect(adapter.stream(request({ [key]: value }))), { message: 'dsh_request_settings_invalid' }); assert.equal(calls.length, 0); }
  }
  for (const maxTokens of [undefined, null, 0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) { const { adapter, calls } = fixture({ ...model(), maxTokens }); await assert.rejects(collect(adapter.stream(request())), { message: 'dsh_model_limits_invalid' }); assert.equal(calls.length, 0); }
});
test('unknown controls, meaningful unsupported SDK settings and declared unsupported temperature fail closed', async () => {
  for (const extra of [{ reasoning: 'high' }, { topP: 0.5 }, { apiKey: 'synthetic' }, { samplingParams: {} }]) { const { adapter, calls } = fixture(); await assert.rejects(collect(adapter.stream(request(extra))), { message: 'dsh_request_settings_invalid' }); assert.equal(calls.length, 0); }
  for (const extra of [{ system: '' }, { system: 'Fixture override' }, { stop: [] }, { stop: ['END'] }, { purpose: 'compaction' }, { purpose: 'session-title' }]) { const { adapter, calls } = fixture(); await assert.rejects(collect(adapter.stream(request(extra))), { message: 'dsh_request_settings_unsupported' }); assert.equal(calls.length, 0); }
  const { adapter, calls } = fixture({ ...model(), compat: { supportsTemperature: false } }); await assert.rejects(collect(adapter.stream(request({ temperature: 1 }))), { message: 'dsh_request_settings_unsupported' }); assert.equal(calls.length, 0);
});
test('non-enumerable and symbol unknown request keys are rejected before runtime', async () => {
  for (const key of ['unknownHiddenSetting', Symbol('unknown-setting')]) {
    const input = request(); Object.defineProperty(input, key, { value: undefined, enumerable: false });
    const { adapter, calls } = fixture(); await assert.rejects(collect(adapter.stream(input)), { message: 'dsh_request_settings_invalid' }); assert.equal(calls.length, 0);
  }
});
test('model routing rejects mismatches and bad signal/session types without touching the supplied runtime', async () => {
  const { adapter, calls } = fixture(); await assert.rejects(adapter.resolveModel('other', 'tiny'), { message: 'model_route_mismatch' });
  for (const extra of [{ provider: 'other' }, { model: 'other' }]) await assert.rejects(collect(adapter.stream(request(extra))), { message: 'model_route_mismatch' });
  for (const extra of [{ signal: null }, { signal: {} }, { sessionId: 1 }]) await assert.rejects(collect(adapter.stream(request(extra))), { message: 'dsh_request_settings_invalid' });
  assert.equal(calls.length, 0);
});
test('an already-aborted signal reaches the runtime unchanged and preserves the existing terminal mapping', async () => {
  const response = answer(); response.stopReason = 'aborted'; const { adapter, calls } = fixture(model(), response), controller = new AbortController(); controller.abort();
  const chunks = await collect(adapter.stream(request({ signal: controller.signal }))); assert.equal(calls[0].options.signal, controller.signal); assert.equal(calls[0].options.signal.aborted, true); assert.equal(chunks.at(-1).reason.kind, 'aborted');
});
test('real installed Hub DSH loop emits standard request fields, retains defaults/replay outputs and performs no model IO', async () => {
  const { runtime, calls, model } = fixture(), incoming = [];
  class AuditedAdapter extends PiRuntimeAdapter { async *stream(request) { incoming.push(request); yield* super.stream(request); } }
  const adapter = new AuditedAdapter(model, runtime, undefined, undefined, 'fixed-native-session');
  const session = await createDshSession({ model, adapter, tools: [], systemPrompt: 'Fixture system', sessionId: 'hub-real-loop-fixture' });
  try {
    const native = await session.prompt('Fixture request'); const events = native.snapshotEvents();
    assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed'); assert.equal(incoming.length, 1); assert.equal(calls.length, 1);
    assert.equal(incoming[0].provider, model.provider); assert.equal(incoming[0].model, model.id); assert.equal(incoming[0].maxTokens, model.maxTokens);
    for (const key of ['temperature', 'reasoningEffort', 'system', 'stop', 'purpose']) assert.equal(incoming[0][key], undefined, `current Hub loop ${key}`);
    assert.equal(calls[0].options.sessionId, 'fixed-native-session'); assert.equal(calls[0].options.signal, incoming[0].signal); assert.ok(JSON.stringify(events).includes('FIXTURE_OK'));
  } finally { await session.dispose(); }
});
