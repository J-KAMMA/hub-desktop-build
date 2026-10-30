import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, realpath, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {validateGeneration, generationOptions} from './generation.mjs';
import {createDshSession} from '../dsh/hub-runtime.mjs';
import {runDsh} from '../dsh/run.mjs';
const base = fileURLToPath(new URL('../', import.meta.url));
const sdk = await import(pathToFileURL(base + 'pi-sidecar/workspace/node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
const ai = await import(pathToFileURL(base + 'pi-sidecar/workspace/node_modules/@earendil-works/pi-ai/dist/index.js'));
const {PiRuntimeAdapter} = await import(pathToFileURL(base + 'dsh/pi-adapter.mjs'));
const {localRequestOptions} = await import(pathToFileURL(base + 'pi-sidecar/model-context.mjs'));
const model = () => ({provider: 'ollama', id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1',
  reasoning: true, thinkingLevelMap: {xhigh: 'extra', max: 'maximum'}, input: ['text'], contextWindow: 32768, maxTokens: 8192,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}});
const profile = (reasoning = 'low') => ({temperature: 0.4, maxTokens: 512, reasoning});
const answer = selected => ({role: 'assistant', content: [{type: 'text', text: 'SYNTHETIC_GENERATION_OK'}],
  api: selected.api, provider: selected.provider, model: selected.id, stopReason: 'stop', timestamp: Date.now(),
  usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}});
const fakeRuntime = (generation, calls) => ({streamSimple(selected, context, options) {
  const effective = generationOptions(selected, options, generation); calls.push({selected, context, options: effective});
  const stream = ai.createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({type: 'done', reason: 'stop', message: answer(selected)})); return stream;
}});

test('closed required DTO accepts exact numeric boundaries and only the documented actual SDK levels', () => {
  for (const temperature of [0, -0, 2]) for (const maxTokens of [1, 8192]) for (const reasoning of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(validateGeneration({temperature, maxTokens, reasoning}, model()), {temperature: temperature === 0 ? 0 : temperature, maxTokens, reasoning});
  for (const key of ['temperature', 'maxTokens', 'reasoning']) {const input = profile(); delete input[key]; assert.throws(() => validateGeneration(input, model()), /comparison_generation_invalid/);}
  for (const input of [undefined, null, [], {}, {...profile(), extra: true}, {...profile(), temperature: '0.4'}, {...profile(), maxTokens: 1.1}, {...profile(), reasoning: 'ultra'}]) assert.throws(() => validateGeneration(input, model()), /comparison_generation_invalid/);
  for (const temperature of [NaN, Infinity, -0.1, 2.1]) assert.throws(() => validateGeneration({...profile(), temperature}, model()), /comparison_generation_invalid/);
  for (const maxTokens of [0, 8193, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateGeneration({...profile(), maxTokens}, model()), /comparison_generation_invalid/);
  for (const key of ['hidden', Symbol('unknown')]) {const input = profile(); Object.defineProperty(input, key, {value: true}); assert.throws(() => validateGeneration(input, model()), /comparison_generation_invalid/);}
  const input = profile(); Object.defineProperty(input, 'temperature', {get() {throw Error('getter must not run');}}); assert.throws(() => validateGeneration(input, model()), /comparison_generation_invalid/);
});

test('comparison is local Ollama only and rejects parser aliases, credentials, ports and model unsupported settings before inference', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.ok(validateGeneration(profile(), {...model(), baseUrl: `http://${host}:11434/v1`}));
  for (const baseUrl of ['https://localhost:11434/v1', 'http://localhost/v1', 'http://localhost:11435', 'http://user:pass@localhost:11434/v1', 'http://example.invalid:11434/v1', 'http://127.1:11434/v1', 'http://2130706433:11434/v1', 'http://localhost:11434/v1?x=1', 'http://localhost:11434/v1#x', 'http://localhost:11434/v1\n', 'http://localhost:11434\\v1']) assert.throws(() => validateGeneration(profile(), {...model(), baseUrl}), /comparison_generation_unsupported/);
  for (const selected of [{...model(), provider: 'other'}, {...model(), maxTokens: 511}, {...model(), maxTokens: NaN}, {...model(), compat: {supportsTemperature: false}}, {...model(), reasoning: false}, {...model(), thinkingLevelMap: {low: null}}]) assert.throws(() => validateGeneration(profile(), selected), /comparison_generation_unsupported/);
  assert.throws(() => validateGeneration(profile('xhigh'), {...model(), thinkingLevelMap: {}}), /comparison_generation_unsupported/);
  assert.ok(validateGeneration(profile('off'), {...model(), reasoning: false}));
});

test('generation wrapper preserves abort/session/payload context and legacy object identity; local output budgeting remains bounded', async () => {
  const options = {signal: new AbortController().signal, sessionId: 'synthetic-session', onPayload: body => ({...body, retained: true}), maxTokens: 2000, reasoning: 'high'};
  assert.equal(generationOptions(model(), options, undefined), options);
  const effective = generationOptions(model(), options, profile('off'));
  assert.equal(effective.signal, options.signal); assert.equal(effective.sessionId, options.sessionId); assert.equal(effective.onPayload, options.onPayload); assert.equal(effective.reasoning, undefined);
  const bounded = localRequestOptions({...model(), contextWindow: 1024}, {systemPrompt: 'Fixture.', messages: [], tools: []}, effective);
  const body = await bounded.onPayload({max_completion_tokens: 2000}, model()); assert.ok(body.max_tokens <= 512); assert.equal(body.retained, true); assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
});

async function realPi(selected, generation, calls) {
  const cwd = await mkdtemp(join(tmpdir(), 'hub-generation-')), agentDir = join(cwd, 'agent'); await mkdir(agentDir);
  await writeFile(join(agentDir, 'auth.json'), '{}'); await writeFile(join(agentDir, 'models.json'), '{}');
  const runtime = await sdk.ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json')});
  runtime.hasConfiguredAuth = () => true; runtime.checkAuth = async () => 'synthetic'; runtime.getAuth = async () => ({auth: {apiKey: 'synthetic'}, env: {}}); runtime.isUsingOAuth = () => false;
  runtime.streamSimple = fakeRuntime(generation, calls).streamSimple;
  const settingsManager = sdk.SettingsManager.inMemory({retry: {enabled: false}, compaction: {enabled: false}});
  const resourceLoader = new sdk.DefaultResourceLoader({cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Synthetic fixture.'}); await resourceLoader.reload();
  const {session} = await sdk.createAgentSession({cwd, agentDir, model: selected, modelRuntime: runtime, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(cwd), noTools: 'all', customTools: [], ...(generation ? {thinkingLevel: generation.reasoning} : {})});
  try {await session.prompt('Synthetic request.', {expandPromptTemplates: false}); assert.equal(session.agent.state.messages.at(-1).content[0].text, 'SYNTHETIC_GENERATION_OK'); return session.thinkingLevel;}
  finally {await session.abort(); session.dispose(); const target = await realpath(cwd), rel = relative(await realpath(tmpdir()), target); if (!rel || rel.startsWith('..') || isAbsolute(rel) || !basename(target).startsWith('hub-generation-')) throw Error('unsafe_fixture_cleanup'); await rm(target, {recursive: true, force: true});}
}

test('actual pinned Pi SDK and DSH agent loop deliver equal effective settings at ModelRuntime entry, including off', async () => {
  for (const reasoning of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const selected = model(), generation = validateGeneration(profile(reasoning), selected), piCalls = [], dshCalls = [];
    assert.equal(await realPi(selected, generation, piCalls), reasoning);
    // DSH request must already carry the requested values, before the shared runtime wrapper.
    const incoming = [];
    class Audit extends PiRuntimeAdapter {async *stream(request) {incoming.push(request); yield* super.stream(request);}}
    const session = await createDshSession({model: selected, generation, tools: [], systemPrompt: 'Synthetic fixture.', adapter: new Audit(selected, fakeRuntime(generation, dshCalls))});
    try {const result = await session.prompt('Synthetic request.'); assert.equal(result.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');}
    finally {await session.dispose();}
    assert.equal(incoming.length, 1); assert.equal(incoming[0].temperature, generation.temperature); assert.equal(incoming[0].maxTokens, generation.maxTokens); assert.equal(incoming[0].reasoningEffort, reasoning === 'off' ? undefined : reasoning);
    assert.equal(piCalls.length, 1); assert.equal(dshCalls.length, 1);
    const actual = call => ({temperature: call.options.temperature, maxTokens: call.options.maxTokens, reasoning: call.options.reasoning});
    assert.deepEqual(actual(piCalls[0]), actual(dshCalls[0])); assert.deepEqual(actual(piCalls[0]), {temperature: 0.4, maxTokens: 512, reasoning: reasoning === 'off' ? undefined : reasoning});
    for (const call of [...piCalls, ...dshCalls]) {assert.equal(call.selected, selected); assert.ok(call.options.signal instanceof AbortSignal); assert.equal(typeof call.options.sessionId, 'string');}
  }
});

test('runDsh canonicalizes accepted negative zero and retains checkpoint/results without extra model inference', async () => {
  const selected = model(), generation = {...profile('off'), temperature: -0}, calls = [], frames = [];
  const ok = await runDsh({model: selected, generation, runtime: fakeRuntime(generation, calls), tools: [], systemPrompt: 'Synthetic fixture.', prompt: 'Synthetic request.', send: frame => frames.push(frame), progress: {reason: null}});
  assert.equal(ok, true); assert.equal(calls.length, 1); assert.equal(calls[0].options.temperature, 0); assert.equal(calls[0].options.maxTokens, 512);
  assert.ok(frames.some(frame => frame.type === 'checkpoint' && frame.entries[0].type === 'dsh-session')); assert.ok(frames.some(frame => frame.event?.type === 'message_end'));
});

test('normal Pi session retains SDK default reasoning and normal DSH retains model cap/provider default settings', async () => {
  const selected = model(), piCalls = [], dshCalls = [];
  assert.equal(await realPi(selected, undefined, piCalls), 'medium'); assert.equal(piCalls[0].options.temperature, undefined); assert.equal(piCalls[0].options.reasoning, 'medium');
  const session = await createDshSession({model: selected, tools: [], systemPrompt: 'Synthetic fixture.', adapter: new PiRuntimeAdapter(selected, fakeRuntime(undefined, dshCalls))});
  try {await session.prompt('Synthetic request.');} finally {await session.dispose();}
  assert.equal(dshCalls[0].options.temperature, undefined); assert.equal(dshCalls[0].options.reasoning, undefined); assert.equal(dshCalls[0].options.maxTokens, selected.maxTokens);
});

test('sidecar connection explicitly validates initial frame profile and echoes only verified generation in both hello frames', async () => {
  const source = await readFile(new URL('./pi-sidecar.src.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('validateGeneration(initialization.generation, model)')); assert.ok(source.includes('generationOptions(selected, options, generation)')); assert.ok(source.includes('thinkingLevel: generation.reasoning'));
  assert.equal(source.match(/\.\.\.\(generation \? \{ generation \} : \{\}\)/g).length, 2);
});
