import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSteeringController, steeringEventMetadata } from './steering.mjs';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const frame = (number, text = 'Literal fixture instruction') => ({ type: 'steer', requestId: id(number), text });
function mock(options = {}) {
  const calls = []; let running = true, stopped = false;
  const session = { get isStreaming() { return running; }, async prompt(text, config) { calls.push({ text, config }); config.preflightResult(true); }, extensionRunner: { hasHandlers: () => false } };
  const controller = createSteeringController({ getSession: () => session, stopped: () => stopped, ...options });
  return { controller, session, calls, setRunning: value => { running = value; }, stop: () => { stopped = true; } };
}
const rejected = (number, code) => ({ type: 'steer_ack', requestId: id(number), accepted: false, code });

test('SDK acceptance ACK contains no text and preserves raw whitespace/literal options and evolving goal', async () => {
  const { controller, calls } = mock(), input = frame(1, '  /skill:trap @fixture-file\n\tliteral  ');
  assert.equal(controller.currentGoal('Initial'), 'Initial');
  assert.deepEqual(await controller.handle(input), { type: 'steer_ack', requestId: id(1), accepted: true });
  assert.equal(calls[0].text, input.text); assert.equal(calls[0].config.streamingBehavior, 'steer'); assert.equal(calls[0].config.expandPromptTemplates, false);
  assert.ok(controller.currentGoal('Initial').includes(input.text)); assert.ok(controller.currentGoal('Initial').includes('permissions are unchanged'));
  assert.equal(JSON.stringify(await controller.handle(input)).includes(input.text), false);
});
test('deduplicates same-ID text including in-flight requests and rejects changed text without requeueing', async () => {
  const { controller, session, calls } = mock(); let release;
  session.prompt = async (text, config) => { calls.push({ text, config }); await new Promise(resolve => { release = resolve; }); config.preflightResult(true); };
  const first = controller.handle(frame(1)), again = controller.handle(frame(1)); assert.equal(first, again);
  await Promise.resolve(); assert.equal(calls.length, 1);
  assert.deepEqual(await controller.handle(frame(1, 'Changed')), rejected(1, 'steer_id_conflict'));
  release(); assert.deepEqual(await first, await again); assert.deepEqual(await controller.handle(frame(1)), await first); assert.equal(calls.length, 1);
});
test('validates exact keys, UUID, raw UTF16, NUL and malformed Unicode before SDK use', async () => {
  const { controller, calls } = mock();
  for (const text of ['', ' \n ', 'x'.repeat(8001), '🧪'.repeat(4001), '\0', '\ud800', '\udc00', null, 1]) assert.deepEqual(await controller.handle(frame(1, text)), rejected(1, 'steer_invalid_request'));
  for (const extra of [{ mode: 'followUp' }, { images: [] }, { allowWrite: true }]) assert.deepEqual(await controller.handle({ ...frame(1), ...extra }), rejected(1, 'steer_invalid_request'));
  const symbol = { ...frame(1), [Symbol('unknown')]: true }; assert.deepEqual(await controller.handle(symbol), rejected(1, 'steer_invalid_request'));
  for (const requestId of [null, 'invalid', id(1).replace('-4', '-1'), id(1) + '\n']) assert.equal(await controller.handle({ ...frame(1), requestId }), null);
  assert.equal(calls.length, 0); assert.equal((await controller.handle(frame(2, '🧪'.repeat(4000)))).accepted, true);
});
test('enforces 16 requests and 32768 cumulative UTF16 units without charging duplicates again', async () => {
  const first = mock(); for (let i = 1; i <= 16; i++) assert.equal((await first.controller.handle(frame(i))).accepted, true);
  assert.equal((await first.controller.handle(frame(1))).accepted, true); assert.deepEqual(await first.controller.handle(frame(17)), rejected(17, 'steer_limit')); assert.equal(first.calls.length, 16);
  const second = mock(); for (let i = 1; i <= 4; i++) assert.equal((await second.controller.handle(frame(i, 'x'.repeat(8000)))).accepted, true);
  assert.equal((await second.controller.handle(frame(5, 'x'.repeat(768)))).accepted, true); assert.deepEqual(await second.controller.handle(frame(6, 'x')), rejected(6, 'steer_limit')); assert.equal(second.calls.length, 5);
});
test('unsupported/startup/idle/stopped/input-hook/error states reject with fixed codes and do not start a model turn', async () => {
  const none = createSteeringController({ getSession: () => null }); assert.deepEqual(await none.handle(frame(1)), rejected(1, 'steer_not_ready'));
  const unsupported = mock({ enabled: () => false }); assert.deepEqual(await unsupported.controller.handle(frame(1)), rejected(1, 'steer_unsupported')); assert.equal(unsupported.calls.length, 0);
  const idle = mock(); idle.setRunning(false); assert.deepEqual(await idle.controller.handle(frame(1)), rejected(1, 'steer_not_streaming')); assert.equal(idle.calls.length, 0);
  const stopped = mock(); stopped.stop(); assert.deepEqual(await stopped.controller.handle(frame(1)), rejected(1, 'steer_stopped')); assert.equal(stopped.calls.length, 0);
  const hooked = mock(); hooked.session.extensionRunner.hasHandlers = () => true; assert.deepEqual(await hooked.controller.handle(frame(1)), rejected(1, 'steer_unsupported')); assert.equal(hooked.calls.length, 0);
  const failure = mock(); failure.session.prompt = async () => { throw Error('synthetic sensitive diagnostic'); }; assert.deepEqual(await failure.controller.handle(frame(1)), rejected(1, 'steer_failed'));
  const noProof = mock(); noProof.session.prompt = async () => {}; assert.deepEqual(await noProof.controller.handle(frame(1)), rejected(1, 'steer_failed'));
});
test('closing-before-queue rejects but acceptance-before-cancel remains SDK acceptance, never delivery/persistence', async () => {
  const before = mock(); const pending = before.controller.handle(frame(1)); before.controller.close(); assert.deepEqual(await pending, rejected(1, 'steer_stopped')); assert.equal(before.calls.length, 0);
  const after = mock(); after.session.prompt = async (_text, config) => { config.preflightResult(true); after.stop(); after.controller.close(); throw Error('cancelled after acceptance'); };
  assert.equal((await after.controller.handle(frame(1))).accepted, true); assert.equal((await after.controller.handle(frame(1))).accepted, true); assert.deepEqual(await after.controller.handle(frame(2)), rejected(2, 'steer_stopped'));
});
test('diagnostic user/aggregate/queue events expose metadata only while model output is left unchanged', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'PRIVATE_FIXTURE_TEXT' }], timestamp: 1 }, assistant = { role: 'assistant', content: [{ type: 'text', text: 'MODEL_OUTPUT' }] };
  assert.deepEqual(steeringEventMetadata({ type: 'queue_update', steering: ['PRIVATE_FIXTURE_TEXT'], followUp: [] }), { type: 'queue_update', steeringCount: 1, followUpCount: 0 });
  for (const type of ['message_start', 'message_end']) assert.equal(JSON.stringify(steeringEventMetadata({ type, message: user })).includes('PRIVATE_FIXTURE_TEXT'), false);
  const result = steeringEventMetadata({ type: 'agent_end', messages: [user, assistant] }); assert.equal(JSON.stringify(result).includes('PRIVATE_FIXTURE_TEXT'), false); assert.equal(result.messages[1], assistant);
});

const workspacePackage = fileURLToPath(new URL('./workspace/package.json', import.meta.url));
const sdkBase = pathToFileURL(workspacePackage);
const sdk = await import(new URL('./node_modules/@earendil-works/pi-coding-agent/dist/index.js', sdkBase).href);
const ai = await import(new URL('./node_modules/@earendil-works/pi-ai/dist/index.js', sdkBase).href);
async function realFixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'hub-steering-')), agentDir = join(cwd, 'agent'); await mkdir(agentDir);
  await writeFile(join(agentDir, 'auth.json'), '{}'); await writeFile(join(agentDir, 'models.json'), '{}');
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') }); runtime.hasConfiguredAuth = () => true;
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Synthetic fixture.' }); await resourceLoader.reload();
  const model = { id: 'stub', name: 'Stub', api: 'stub', provider: 'stub', baseUrl: 'http://127.0.0.1', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const sessionManager = sdk.SessionManager.inMemory(cwd), { session } = await sdk.createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, settingsManager, resourceLoader, sessionManager, noTools: 'all', customTools: [] });
  const calls = [], metadata = []; let started, release; const firstStarted = new Promise(resolve => { started = resolve; });
  session.subscribe(event => metadata.push(steeringEventMetadata(event)));
  session._expandSkillCommand = () => { throw Error('template trap'); }; session._tryExecuteExtensionCommand = () => { throw Error('extension trap'); };
  session.agent.streamFunction = async (_model, context) => {
    const stream = ai.createAssistantMessageEventStream(); calls.push(context);
    const finish = () => { const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; stream.push({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'FIXTURE_MODEL_OUTPUT' }], api: 'stub', provider: 'stub', model: 'stub', usage, stopReason: 'stop', timestamp: Date.now() } }); };
    if (calls.length === 1) { release = finish; started(); } else queueMicrotask(finish);
    return stream;
  };
  return { session, sessionManager, calls, metadata, firstStarted, release: () => release(), async cleanup() {
    await session.abort(); session.dispose(); const root = await realpath(tmpdir()), target = await realpath(cwd), rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !basename(target).startsWith('hub-steering-')) throw Error('unsafe fixture cleanup'); await rm(target, { recursive: true, force: true });
  } };
}
test('real pinned SDK accepts raw literal into queue without templates/files/extension expansion, then records delivery in context only', async () => {
  const fixture = await realFixture(), text = '/skill:trap @do-not-read.txt\n\t PRIVATE_LITERAL_MARKER  ';
  try {
    const running = fixture.session.prompt('Initial fixture request', { expandPromptTemplates: false }); await fixture.firstStarted;
    const controller = createSteeringController({ getSession: () => fixture.session }); assert.equal(fixture.session.isStreaming, true);
    const receipt = await controller.handle(frame(1, text)); assert.equal(receipt.accepted, true); assert.deepEqual(fixture.session.getSteeringMessages(), [text]);
    assert.equal(JSON.stringify(fixture.sessionManager.getBranch()).includes('PRIVATE_LITERAL_MARKER'), false, 'accepted is not delivery/checkpoint'); assert.equal(fixture.calls.length, 1);
    fixture.release(); await running;
    assert.equal(fixture.calls.length, 2); assert.ok(fixture.calls[1].messages.some(message => message.role === 'user' && message.content.some(block => block.text === text)));
    assert.ok(JSON.stringify(fixture.sessionManager.getBranch()).includes('PRIVATE_LITERAL_MARKER'), 'delivered context remains available for encrypted checkpoint transport');
    assert.equal(JSON.stringify(fixture.metadata).includes('PRIVATE_LITERAL_MARKER'), false); assert.equal(fixture.session.pendingMessageCount, 0);
    assert.equal((await controller.handle(frame(2, 'idle request'))).code, 'steer_not_streaming'); assert.equal(fixture.calls.length, 2);
  } finally { await fixture.cleanup(); }
});
