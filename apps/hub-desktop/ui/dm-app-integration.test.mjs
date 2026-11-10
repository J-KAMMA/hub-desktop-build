import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, webcrypto } from 'node:crypto';
import { createDmController } from './dm-controller.mjs';
import { createState } from './state-view.mjs';
import { addBaitRow, confirmLeave } from './outbound-link.mjs';
import { detectBait } from './bait-warning.mjs';

const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html',import.meta.url), 'utf8');
function section(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `actual app extraction seam: ${from}`);
  return source.slice(start, end);
}
const accountSource = section('function renderDesktopAccount(status)', 'async function refreshDesktopAccount(');
const attachmentSource = section('function imageAttachmentControl(', '\nlet feedImageEpoch=');
const dmSource = section('let messagesData=null,dmController=null', '// --- メール（');
const setupSource = section('// DM コンポーザーの添付UI。', '// Public page links are previews; the existing composer remains the only submit path.');
const exitHook = source.match(/if\(previousView==='messages'&&view!=='messages'\)closeDmView\(\);/)?.[0];
assert.ok(exitHook, 'actual showView must invalidate DM on exit');
const origin = 'http://127.0.0.1:3020';
const imageId = '12345678-1234-4123-8123-123456789abc';
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate, reason) {
  for (let i = 0; i < 60; i++) { if (predicate()) return; await tick(); }
  assert.fail(`synthetic operation did not reach ${reason}`);
}
const scope = (device = 'device-a', generation = 1) => ({ key: JSON.stringify([origin, device]), generation });
function conversation(id, viewer = 'viewer-a', isE2ee = false) {
  return { id, participantIds: [viewer, 'peer'], isE2ee, verificationStatus: 'unverified', fingerprint: '', unreadCountByProfileId: { [viewer]: 1 }, lastMessageAt: '2026-10-07T00:00:00.000Z' };
}
function message(text, id = 'message-a', conversationId = 'conversation-a', viewer = 'peer', images = []) {
  return { id, conversationId, senderProfileId: viewer, previewText: text, encryptedPayload: '', encryptionVersion: 'plaintext-v1', encryptionState: 'sealed', createdAt: '2026-10-07T00:00:00.000Z', images };
}
function packet(viewer = 'viewer-a') {
  return { currentProfileId: viewer, conversations: ['conversation-a', 'conversation-b'].map(id => conversation(id, viewer)),
    messages: [message('A private text'), message('B private text', 'message-b', 'conversation-b')],
    profiles: [{ id: viewer, displayName: 'Owner', handle: 'owner' }, { id: 'peer', displayName: '<b>Peer</b>', handle: 'peer' }], messageCount: 2 };
}
function prepared(url = 'blob:synthetic-draft', bytes) {
  return { previewUrl: url, blob: { arrayBuffer: bytes ?? (async () => new Uint8Array([1, 2]).buffer) },
    thumbnailBlob: { arrayBuffer: async () => new Uint8Array([3]).buffer }, width: 10, height: 10, thumbnailWidth: 10, thumbnailHeight: 10 };
}
function fixture(t, connected = true) {
  const dom = new JSDOM(html, { url: 'http://shell.test' });
  const f = { window: dom.window, document: dom.window.document, calls: [], revoked: [], created: [],
    scope: connected ? scope() : null, packet: packet(), handler: null, process: async () => prepared(), sentHome: 0 };
  const invoke = async (command, args) => {
    f.calls.push({ command, args: structuredClone(args) });
    if (f.handler) { const result = f.handler(command, args); if (result !== undefined) return result; }
    if (command === 'hub_detail') return structuredClone(f.packet);
    if (command === 'hub_dm_image') return { bytes: [1], mimeType: 'image/webp' };
    if (command === 'hub_upload_dm_image') return { image: { id: imageId } };
    if (args?.action === 'read_conversation') return { viewerId: f.packet.currentProfileId, conversationId: args.target, unreadCount: 0 };
    if (args?.action === 'send_message') {
      const id = 'dm-' + createHash('sha256').update(JSON.stringify(['hub-dm-send-v1', args.options.expectedViewerId, args.target, args.requestId])).digest('hex');
      return { viewerId: args.options.expectedViewerId, message: message(args.text, id, args.target, args.options.expectedViewerId,
        (args.options.imageIds ?? []).map(id => ({ id, url: '/api/media/dm-images/fixture', fullUrl: '/api/media/dm-images/fixture?variant=full', width: 10, height: 10, altText: '' }))) };
    }
    throw Error('unexpected synthetic command');
  };
  const URLFixture = { createObjectURL() { const url = `blob:synthetic-cache-${f.created.length}`; f.created.push(url); return url; }, revokeObjectURL(url) { f.revoked.push(url); } };
  const emptyState = (_icon, title = '', body = '') => { const el = f.document.createElement('p'); el.textContent = `${title} ${body}`; return el; };
  const statePanel = (_icon, title = '', body = '', retry) => {
    const el = f.document.createElement('div'); el.className = 'state-panel';
    const heading = f.document.createElement('p'); heading.className = 'state-title'; heading.textContent = title;
    const text = f.document.createElement('p'); text.className = 'state-body'; text.textContent = body;
    el.append(heading, text);
    if (retry) { const button = f.document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary state-action'; button.textContent = '再試行'; button.onclick = () => retry(); el.append(button); }
    return el;
  };
  const actionButton = (label, className, callback) => { const el = f.document.createElement('button'); el.type = 'button'; el.className = className; el.textContent = label; el.onclick = callback; return el; };
  const code = `let currentView='messages',desktopAccount={state:'signed_out'},desktopAccountLoaded=true;
    const railActivityReady=false,railLoadRevision=new Map(),railLoaded=new Set();
    ${accountSource}\n${attachmentSource}\n${dmSource}\n${setupSource}
    return {controller:dmController,load:loadMessages,open:openConversation,account:renderDesktopAccount,
      selected:()=>activeConversationId,data:()=>messagesData,attachment:dmAttachment,result:dmResult,check:dmCheck,retry:dmRetry,
      input:dmInput,form:dmForm,cache:dmImageUrls,drafts:dmDrafts,
      view(view){const previousView=currentView;${exitHook}currentView=view;},
      blank(){activeConversationId=null;renderThread();},
      state:()=>document.querySelector('#thread-state').textContent};`;
  const parameters = { renderSidebarContext: () => {}, document: f.document, window: f.window, Event: f.window.Event, URL: URLFixture, Blob, TextEncoder, crypto: webcrypto,
    createDmController, createState, addBaitRow, detectBait, icon: () => '', invoke, articleEditorScope: async () => f.scope, processComposerImage: file => f.process(file), actionButton, emptyState, statePanel,
    connectState: detail => emptyState('account', 'Hubへの接続', detail),
    paintAvatar: () => {}, relTime: () => 'synthetic date', navigateFrom: () => {},
    setBadge: (id, value) => { f.document.getElementById(id).textContent = String(value); },
    loadHomeSummary: async () => { f.sentHome++; }, refreshSavedSearchScope: async () => {}, refreshRailActivity: async () => {} };
  // Same realm as the imported controller: no cross-realm DTO/prototype exemption.
  f.api = Function(...Object.keys(parameters), code)(...Object.values(parameters));
  f.edit = text => { f.api.input.value = text; f.api.input.dispatchEvent(new f.window.Event('input')); };
  f.pick = files => { const input = f.api.attachment.element.querySelector('input'); Object.defineProperty(input, 'files', { configurable: true, value: files }); return input.onchange(); };
  f.sends = () => f.calls.filter(call => call.args?.action === 'send_message');
  f.uploads = () => f.calls.filter(call => call.command === 'hub_upload_dm_image');
  f.connect = async (device = 'device-a', viewer = 'viewer-a', generation = 1) => {
    f.scope = scope(device, generation); f.packet = packet(viewer); f.api.account({ state: 'registered', deviceId: device });
    await until(() => f.api.data()?.currentProfileId === viewer && f.api.selected() === 'conversation-a', 'connected own conversation'); await tick();
  };
  t.after(() => { f.api.controller.destroy(); dom.window.close(); });
  return f;
}

test('initial signed-out page clears private content; actual account lifecycle loads readable conversations', async t => {
  const f = fixture(t, false);
  assert.equal(await f.api.load(), false); assert.equal(f.api.form.hidden, true); assert.equal(f.calls.length, 0);
  await f.connect();
  assert.equal(f.api.form.hidden, false); assert.match(f.document.querySelector('#thread-list').textContent, /A private text/);
  assert.match(f.api.state(), /<b>Peer<\/b>/); assert.equal(f.document.querySelector('#thread-state b'), null);
  assert.equal(f.document.getElementById('nav-badge-messages').textContent, '2');
});

test('actual conversation selection restores separate text/image drafts; detached old card cannot navigate', async t => {
  const f = fixture(t); await f.api.load('conversation-a');
  f.edit('draft A'); await f.pick([{ name: 'synthetic.png' }]);
  const oldCard = f.document.querySelector('#messages-list .conversation');
  assert.equal(await f.api.open('conversation-b'), true); f.edit('draft B');
  assert.equal(f.api.attachment.images.length, 0); assert.equal(await f.api.open('conversation-a'), true);
  assert.equal(f.api.input.value, 'draft A'); assert.equal(f.api.attachment.images[0].previewUrl, 'blob:synthetic-draft');
  const before = f.calls.length; oldCard.onclick(); await tick(); assert.equal(f.calls.length, before);
  assert.equal(await f.api.open('conversation-b'), true); assert.equal(f.api.input.value, 'draft B');
});

test('switching conversation during image processing drops/revokes the acquired image instead of attaching to B', async t => {
  const f = fixture(t); await f.api.load('conversation-a'); f.edit('draft A');
  const acquired = deferred(); f.process = () => acquired.promise; const picking = f.pick([{ name: 'synthetic.png' }]);
  assert.equal(await f.api.open('conversation-b'), true); f.edit('draft B');
  acquired.resolve(prepared('blob:late-acquisition')); await picking;
  assert.equal(f.api.attachment.images.length, 0); assert.equal(f.api.input.value, 'draft B');
  assert.ok(f.revoked.includes('blob:late-acquisition')); assert.equal(f.uploads().length, 0); assert.equal(f.sends().length, 0);
});

test('account change during image byte preparation sends no image/text and cannot replace new viewer draft', async t => {
  const f = fixture(t); await f.api.load('conversation-a'); f.edit('old viewer draft');
  const bytes = deferred(); let readingBytes = false;
  f.process = async () => prepared('blob:old-draft', () => { readingBytes = true; return bytes.promise; }); await f.pick([{ name: 'synthetic.png' }]);
  const sending = f.api.controller.send(); await until(() => readingBytes, 'actual root image byte preparation');
  await f.connect('device-b', 'viewer-b', 2); f.edit('new viewer draft'); bytes.resolve(new Uint8Array([1]).buffer);
  assert.equal(await sending, false); assert.equal(f.uploads().length, 0); assert.equal(f.sends().length, 0);
  assert.equal(f.api.input.value, 'new viewer draft'); assert.equal(f.api.data().currentProfileId, 'viewer-b'); assert.ok(f.revoked.includes('blob:old-draft'));
});

test('send completion preserves a newer same-conversation draft and double submit uses one immutable send', async t => {
  const f = fixture(t); await f.api.load('conversation-a'); f.edit('old draft');
  const ack = deferred(); let held;
  f.handler = (command, args) => { if (args?.action === 'send_message') { held = args; return ack.promise; } };
  f.api.form.dispatchEvent(new f.window.Event('submit', { cancelable: true })); await until(() => f.sends().length === 1, 'one captured send');
  f.api.form.dispatchEvent(new f.window.Event('submit', { cancelable: true })); f.edit('new draft');
  const id = 'dm-' + createHash('sha256').update(JSON.stringify(['hub-dm-send-v1', 'viewer-a', held.target, held.requestId])).digest('hex');
  ack.resolve({ viewerId: 'viewer-a', message: message('old draft', id, held.target, 'viewer-a') });
  await until(() => f.sentHome === 1, 'confirmed send callback'); await tick();
  assert.equal(f.sends().length, 1); assert.equal(f.api.input.value, 'new draft'); assert.equal(f.api.drafts.get('conversation-a').text, 'new draft');
});

test('view exit during POST preserves draft and late ACK performs no private paint or draft clear', async t => {
  const f = fixture(t); await f.api.load('conversation-a'); f.edit('keep after exit');
  const ack = deferred(); f.handler = (_command, args) => args?.action === 'send_message' ? ack.promise : undefined;
  const sending = f.api.controller.send(); await until(() => f.sends().length === 1, 'pending POST');
  const captured = f.sends()[0].args; f.api.view('home');
  const id = 'dm-' + createHash('sha256').update(JSON.stringify(['hub-dm-send-v1', 'viewer-a', captured.target, captured.requestId])).digest('hex');
  ack.resolve({ viewerId: 'viewer-a', message: message(captured.text, id, captured.target, 'viewer-a') });
  assert.equal(await sending, false); assert.equal(f.sentHome, 0); assert.equal(f.api.data(), null);
  assert.equal(f.document.querySelector('#thread-list').textContent, ''); assert.equal(f.api.drafts.get('conversation-a').text, 'keep after exit');
  f.handler = null; f.api.view('messages'); await f.api.load('conversation-a'); assert.equal(f.api.input.value, 'keep after exit');
  assert.equal(await f.api.controller.send(), false); assert.equal(f.sends().length, 1);
});

test('late old-account GET/error/card and cached image cannot expose prior private data or URLs', async t => {
  const f = fixture(t); f.packet.messages[0].images = [{ id: imageId, url: '/api/media/dm-images/fixture', fullUrl: '/api/media/dm-images/fixture', width: 10, height: 10, altText: '' }];
  await f.api.load('conversation-a'); await until(() => f.created.length === 1, 'owned image cache');
  const oldCard = f.document.querySelector('#messages-list .conversation'), oldRead = deferred();
  f.handler = command => command === 'hub_detail' ? oldRead.promise : undefined;
  const reading = f.api.load('conversation-a'); await tick();
  f.handler = null; await f.connect('device-b', 'viewer-b', 2); f.edit('B only');
  oldRead.reject(Error('dm_rejected:403')); assert.equal(await reading, false);
  const before = f.calls.length; oldCard.onclick(); await tick(); assert.equal(f.calls.length, before);
  assert.equal(f.api.data().currentProfileId, 'viewer-b'); assert.equal(f.api.input.value, 'B only');
  assert.ok(f.revoked.includes('blob:synthetic-cache-0')); assert.equal(f.api.cache.size, 0);
});

test('fresh E2EE transition hides composer and never uploads or sends plaintext', async t => {
  const f = fixture(t); await f.api.load('conversation-a'); f.edit('must not send'); await f.pick([{ name: 'synthetic.png' }]);
  f.packet.conversations[0].isE2ee = true;
  assert.equal(await f.api.controller.send(), false); assert.equal(f.api.form.hidden, true);
  assert.match(f.api.state(), /送信できません/); assert.equal(f.uploads().length, 0); assert.equal(f.sends().length, 0);
});

test('actual recovery controls require readonly recheck and resend the exact formal ID/body while keeping new draft', async t => {
  const f = fixture(t); await f.api.load('conversation-a'); f.edit('immutable original');
  f.handler = (_command, args) => { if (args?.action === 'send_message') return Promise.reject(Error('dm_unknown')); };
  assert.equal(await f.api.controller.send(), false); const first = f.sends()[0].args;
  f.edit('new unsent draft'); assert.equal(f.api.retry.disabled, true); assert.equal(await f.api.retry.onclick(), false); assert.equal(f.sends().length, 1);
  await f.api.check.onclick(); assert.equal(f.api.retry.disabled, false); f.handler = null;
  assert.equal(await f.api.retry.onclick(), true); assert.equal(f.sends().length, 2); assert.deepEqual(f.sends()[1].args, first);
  assert.match(first.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(f.api.input.value, 'new unsent draft'); assert.equal(f.sentHome, 1);
});

test('a failed conversation load moves into the conversation list as a state panel with a secondary retry', async t => {
  const f = fixture(t);
  f.handler = command => { if (command === 'hub_detail') throw Error('dm_unknown'); };
  assert.equal(await f.api.load(), false);
  const panel = f.document.querySelector('#messages-list .state-panel');
  assert.ok(panel, 'the load error is shown in the conversation list');
  assert.equal(panel.querySelector('.state-title').textContent, '会話を読み込めませんでした');
  assert.equal(panel.querySelector('.state-body').textContent, '接続と投稿権限を確認してください。');
  assert.equal(f.api.result.textContent, '', 'the old bottom line is not used');
  const retry = panel.querySelector('.state-action');
  assert.ok(retry); assert.ok(retry.classList.contains('btn-secondary'));
  f.handler = null;
  await retry.onclick();
  assert.equal(f.api.data()?.currentProfileId, 'viewer-a');
  assert.equal(f.document.querySelector('#messages-list .state-panel'), null);
});

test('the empty conversation pane uses the shared top-third state panel instead of full-height centring', async t => {
  const f = fixture(t); await f.api.load('conversation-a');
  f.api.blank();
  const panel = f.document.querySelector('#thread-list .state-panel');
  assert.ok(panel, 'the right pane uses .state-panel');
  assert.equal(panel.querySelector('.state-title').textContent, '会話を選択');
  assert.equal(panel.querySelector('.state-action')?.textContent, '新しいメッセージ');
  assert.equal(f.api.state(), '');
  assert.equal(f.api.form.hidden, true);
});
