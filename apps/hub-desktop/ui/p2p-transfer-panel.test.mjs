import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {initP2PTransfer} from './p2p-transfer-panel.mjs';
import {PAIRING_RELAY_ORIGIN, createPairing, pairingLink} from './p2p-pairing.mjs';

const origin = 'https://receiver.example';
const button = (view, label) => [...view.root.querySelectorAll('button')].find(element => element.textContent === label);
const field = (view, label) => view.root.querySelector(`[aria-label="${label}"]`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const file = (size = 3, name = '<img src=x>change.json') => ({size, name, arrayBuffer: async () => new Uint8Array(size).buffer});
function invitation(destination = origin, relay = PAIRING_RELAY_ORIGIN, ticket = createPairing()) {
  const url = new URL('/v2/research/rp_' + 'a'.repeat(32), destination); url.searchParams.set('pairRelay', relay); url.hash = new URL(pairingLink(relay, ticket)).hash; return url.href;
}
function fixture(t, options = {}) {
  const dom = new JSDOM('<main></main>'), reads = [], peers = [], pairs = [], imported = [], blobs = [], revoked = [];
  dom.window.URL.createObjectURL = blob => { blobs.push(blob); return `blob:received-${blobs.length}`; };
  dom.window.URL.revokeObjectURL = value => revoked.push(value);
  const view = initP2PTransfer(dom.window.document.querySelector('main'), {
    invoke: async (name, args) => { reads.push({name, args}); return options.invoke ? options.invoke(name, args) : name === 'hub_origin' ? origin : {status: 204, frame: null}; },
    onReceiveFile: async value => { imported.push(value); },
    peerFactory: (configuration, onChange) => {
      const peer = {configuration, state: {status: '準備中', ready: false, code: '', verified: false, remoteVerified: false}, offered: [], accepted: 0, rejected: 0, closed: 0,
        emit(patch) { this.state = {...this.state, ...patch}; onChange(this.state); },
        verify() { this.emit({verified: true, ready: this.state.remoteVerified}); },
        async offer(value) { if ((await value.arrayBuffer()).byteLength !== value.size) throw Error('ファイルのサイズが変わりました。選び直してください。'); this.offered.push(value); },
        accept() { ++this.accepted; this.emit({pending: undefined}); }, reject() { ++this.rejected; this.emit({pending: undefined}); }, close() { ++this.closed; this.emit({ready: false, code: ''}); }};
      peers.push(peer); return peer;
    },
    pairFactory: (peer, ticket, relayOrigin, role, onError, transport) => {
      const pair = {peer, ticket, origin: relayOrigin, role, onError, transport, closed: 0,
        async connect() { if (options.connect) return options.connect(this); }, close() { ++this.closed; }};
      pairs.push(pair); return pair;
    },
    ...Object.fromEntries(Object.entries(options).filter(([key]) => !['connect', 'invoke'].includes(key))),
  });
  t.after(() => { view.dispose(); dom.window.close(); }); return {...view, dom, reads, peers, pairs, imported, blobs, revoked};
}
async function host(view) { await view.ready; await button(view, '接続の招待を作る').onclick(); }
async function guest(view, url) { await view.ready; field(view, '届いた招待リンク').value = url; field(view, '届いた招待リンク').oninput(); await button(view, 'この招待の端末に接続').onclick(); }
function paired(view, patch = {}) { view.peers.at(-1).emit({code: 'ABCD EFGH IJKL MNOP', verified: true, remoteVerified: true, ready: true, ...patch}); }
async function select(view, value) { const input = field(view, '送信するファイル'); Object.defineProperty(input, 'files', {configurable: true, value: value ? [value] : []}); input.onchange(); }
const request = (pair, changes = {}) => ({origin: pair.origin, room: pair.ticket.room, role: pair.role, expires: pair.ticket.expires, method: 'GET', action: '', body: undefined, signal: new AbortController().signal, ...changes});

test('initialization reads current Hub only; pasting never automatically creates a peer or relay request', async t => {
  const view = fixture(t); await view.ready;
  assert.deepEqual(view.reads, [{name: 'hub_origin', args: undefined}]); assert.equal(view.peers.length, 0);
  const input = field(view, '届いた招待リンク'); input.value = invitation(); input.oninput();
  assert.equal(view.peers.length, 0); assert.equal(view.pairs.length, 0); assert.equal(button(view, 'この招待の端末に接続').disabled, false);
  assert.match(view.root.textContent, /GoogleのSTUN/); assert.match(view.root.textContent, /IPアドレス/);
  assert.equal(view.root.querySelector('img'), null); assert.ok([...view.root.querySelectorAll('button')].every(value => value.type === 'button'));
});

test('explicit host invitation preserves recipient Hub and exposes only allowed relay plus fragment ticket', async t => {
  const view = fixture(t, {invitationUrl: 'https://original.example/v2/research/rp_' + 'a'.repeat(32)}); await host(view);
  const text = field(view, '送る招待リンク'), url = new URL(text.value), pair = view.pairs[0];
  assert.equal(url.origin, 'https://original.example'); assert.equal(url.searchParams.get('pairRelay'), PAIRING_RELAY_ORIGIN);
  assert.equal(url.hash, new URL(pairingLink(pair.origin, pair.ticket)).hash); assert.equal(pair.role, 'host');
  assert.equal(view.reads.length, 1); assert.deepEqual(view.peers[0].configuration.iceServers, [{urls: 'stun:stun.l.google.com:19302'}]);
  const key = pair.ticket.key; paired(view); assert.equal(field(view, '送る招待リンク'), null); assert.equal(text.value, ''); assert.equal(pair.ticket.key, key); assert.ok(pair.closed);
});

test('guest validates destination, exact canonical relay, duplicates, expiry and credentials before connecting', async t => {
  const valid = invitation(); const expired = {...createPairing(), expires: Date.now() - 1};
  for (const value of [invitation('https://foreign.example'), valid.replace('https://receiver.example', 'http://receiver.example'), valid.replace('https://receiver.example', 'https://user:pass@receiver.example'), invitation(origin, 'https://other-relay.example'), invitation(origin, origin + '/'), valid.replace('pairRelay=', 'pairRelay=' + encodeURIComponent(origin) + '&pairRelay='), invitation(origin, origin, expired), valid.replace('#pair=1.', '#pair=2.'), valid.replace(origin, origin + '\\evil')]) {
    const view = fixture(t); await guest(view, value);
    assert.equal(view.peers.length, 0, value); assert.equal(view.pairs.length, 0); assert.equal(view.reads.length, 1); assert.ok(view.root.querySelector('[role="alert"]'));
  }
  for (const relay of [PAIRING_RELAY_ORIGIN, origin]) {
    const view = fixture(t); await guest(view, invitation(origin, relay));
    assert.equal(view.peers.length, 1); assert.equal(view.pairs[0].role, 'guest'); assert.equal(view.pairs[0].origin, relay);
    assert.equal(field(view, '届いた招待リンク'), null); assert.equal(view.reads.length, 1);
  }
});

test('loopback HTTPS/HTTP invitation is valid only at exact selected current Origin', async t => {
  for (const hub of ['http://localhost:3020', 'http://127.0.0.1:3020', 'http://[::1]:3020']) {
    const view = fixture(t, {invoke: async name => name === 'hub_origin' ? hub : {status: 204, frame: null}});
    await guest(view, invitation(hub, hub)); assert.equal(view.pairs[0].origin, hub);
    const other = fixture(t, {invoke: async () => hub}); await guest(other, invitation(hub.replace(':3020', ':3021'), hub)); assert.equal(other.peers.length, 0);
  }
});

test('Native transport emits only fixed command and encrypted byte array; current-Hub selection does not pass URL', async t => {
  const view = fixture(t); await view.ready; field(view, '接続サービス').value = 'hub'; await host(view);
  const pair = view.pairs[0], frame = new Uint8Array(29).buffer;
  for (const [method, action, body, operation] of [['POST', 'start', undefined, 'start'], ['GET', '', undefined, 'poll'], ['POST', 'signal', frame, 'signal']]) {
    const response = await pair.transport(request(pair, {method, action, body})); assert.deepEqual(response, {status: 204, data: null});
    const call = view.reads.at(-1); assert.equal(call.name, 'p2p_pairing_request');
    assert.deepEqual(call.args, {request: {relay: 'hub', room: pair.ticket.room, role: 'host', expires: pair.ticket.expires, operation, ...(body ? {frame: [...new Uint8Array(body)]} : {})}});
    assert.ok(!JSON.stringify(call.args).includes(pair.ticket.key)); assert.ok(!JSON.stringify(call.args).includes(origin));
  }
});

test('transport boundaries reject mixed operations, plaintext, invalid frame sizes, room, expiry and origin before invoke', async t => {
  const view = fixture(t); await host(view); const pair = view.pairs[0];
  const bad = [{origin}, {room: 'a'.repeat(31)}, {room: 'a'.repeat(32) + '\n'}, {role: 'other'}, {expires: Date.now() - 1}, {expires: Date.now() + 700000}, {expires: NaN}, {method: 'PUT'}, {method: 'GET', action: 'start'}, {body: 'SDP'}, {method: 'POST', action: 'signal', body: new Uint8Array(28).buffer}, {method: 'POST', action: 'signal', body: new Uint8Array(90029).buffer}, {method: 'POST', action: 'start', body: new Uint8Array(29).buffer}];
  for (const change of bad) await assert.rejects(pair.transport(request(pair, change)));
  assert.equal(view.reads.length, 1);
  for (const size of [29, 90028]) await pair.transport(request(pair, {method: 'POST', action: 'signal', body: new Uint8Array(size).buffer}));
  assert.deepEqual(view.reads.slice(1).map(value => value.args.request.frame.length), [29, 90028]);
});

test('transport validates response bytes and converts only complete encrypted frames', async t => {
  let response = {status: 200, frame: [...new Uint8Array(29)]};
  const view = fixture(t, {invoke: async name => name === 'hub_origin' ? origin : response}); await host(view); const pair = view.pairs[0];
  assert.deepEqual([...new Uint8Array((await pair.transport(request(pair))).data)], [...new Uint8Array(29)]);
  response = {status: 200, frame: [...new Uint8Array(90028)]}; assert.equal((await pair.transport(request(pair))).data.byteLength, 90028);
  for (const value of [{status: 200, frame: null}, {status: 200, frame: new Array(29)}, {status: 200, frame: new Uint8Array(29)}, {status: 200, frame: [...new Uint8Array(28)]}, {status: 200, frame: [...new Uint8Array(90029)]}, {status: 200, frame: Array(29).fill(256)}, {status: 200, frame: Array(29).fill(1.5)}, {status: 204, frame: []}, {status: 199, frame: null}, {status: 600, frame: null}]) { response = value; await assert.rejects(pair.transport(request(pair))); }
  response = {status: 403, frame: null}; assert.deepEqual(await pair.transport(request(pair)), {status: 403, data: null});
});

test('relay abort and late result after invalidation cannot restore keys, files or received state', async t => {
  for (const mode of ['abort', 'dispose', 'account', 'current']) {
    const pending = deferred(); let alive = true;
    const view = fixture(t, {sendFile: file(), isCurrent: () => alive, invoke: async name => name === 'hub_origin' ? origin : pending.promise}); await host(view);
    const pair = view.pairs[0], input = field(view, '送る招待リンク'), controller = new AbortController();
    const work = pair.transport(request(pair, {signal: controller.signal})); const rejection = assert.rejects(work); await tick();
    if (mode === 'abort') controller.abort();
    if (mode === 'dispose') view.dispose();
    if (mode === 'account') view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed'));
    if (mode === 'current') alive = false;
    pending.resolve({status: 200, frame: [...new Uint8Array(29)]}); await rejection;
    if (mode !== 'abort') { assert.ok(pair.closed); assert.equal(input.value, ''); view.peers[0].emit({code: 'late', ready: true, received: {name: 'late.json', blob: new Blob(['late'])}}); assert.equal(view.blobs.length, 0); assert.doesNotMatch(view.root.textContent, /late/); }
  }
});

test('matching code requires local and remote confirmation before File selection or sending', async t => {
  const view = fixture(t, {sendFile: file()}); await host(view);
  paired(view, {verified: false, remoteVerified: false, ready: false});
  assert.equal(button(view, 'この変更を送信申請'), undefined); await button(view, '同じ番号であることを確認した').onclick();
  assert.equal(button(view, 'この変更を送信申請'), undefined); assert.equal(view.peers[0].offered.length, 0);
  paired(view); assert.equal(view.peers[0].offered.length, 0); await button(view, 'この変更を送信申請').onclick(); assert.equal(view.peers[0].offered.length, 1); assert.equal(view.root.querySelector('img'), null);
});

test('selected files require separate send and enforce actual size, 8KiB Git and 16MiB universal bounds', async t => {
  const view = fixture(t, {maxFileBytes: 8192}); await host(view); paired(view);
  for (const size of [0, 8193, NaN, 1.5]) { await select(view, file(size)); assert.equal(button(view, 'このファイルを送信申請').disabled, true); }
  await select(view, file(8192)); assert.equal(view.peers[0].offered.length, 0); await button(view, 'このファイルを送信申請').onclick(); assert.equal(view.peers[0].offered[0].size, 8192);
  await select(view, {...file(), arrayBuffer: async () => new Uint8Array(2).buffer}); await button(view, 'このファイルを送信申請').onclick(); assert.match(view.root.textContent, /サイズが変わりました/); assert.equal(view.peers[0].offered.length, 1);
  const large = fixture(t, {sendFile: file(16 * 1024 * 1024)}); await host(large); paired(large); assert.equal(button(large, 'この変更を送信申請').disabled, false);
  const tooLarge = fixture(t, {sendFile: file(16 * 1024 * 1024 + 1)}); await host(tooLarge); paired(tooLarge); assert.equal(button(tooLarge, 'この変更を送信申請').disabled, true);
});

test('recipient must explicitly accept or reject and cannot accept beyond the scoped limit', async t => {
  const view = fixture(t, {maxFileBytes: 8192}); await host(view); paired(view);
  view.peers[0].emit({pending: {name: '<img src=x>changes.json', size: 8192}});
  assert.equal(view.peers[0].accepted, 0); assert.equal(view.imported.length, 0); assert.equal(view.root.querySelector('img'), null);
  await button(view, '受信する').onclick(); assert.equal(view.peers[0].accepted, 1);
  view.peers[0].emit({pending: {name: 'too-big.json', size: 8193}}); assert.equal(button(view, '受信する').disabled, true);
  await button(view, '断る').onclick(); assert.equal(view.peers[0].rejected, 1);
});

test('received File exposes download but only distinct action calls proposal import once', async t => {
  const view = fixture(t, {maxFileBytes: 8192}); await host(view); paired(view);
  const blob = new Blob(['{"change":true}']); view.peers[0].emit({received: {name: '<img src=x>change.json', blob}});
  assert.equal(view.imported.length, 0); assert.equal(view.root.querySelector('img'), null); const download = view.root.querySelector('a'); assert.equal(download.href, 'blob:received-1');
  await button(view, '受信した変更の内容を確認').onclick(); assert.equal(view.imported.length, 1); assert.equal(view.imported[0].size, blob.size); assert.equal(await view.imported[0].text(), await blob.text());
  assert.equal(button(view, '受信内容の確認画面へ渡しました').disabled, true);
  view.invalidate(); assert.deepEqual(view.revoked, ['blob:received-1']); const event = new view.dom.window.MouseEvent('click', {cancelable: true}); download.onclick(event); assert.equal(event.defaultPrevented, true); assert.equal(view.root.querySelector('a'), null);
});

test('received over-limit blob and late import completion discard private state', async t => {
  const oversized = fixture(t, {maxFileBytes: 8192}); await host(oversized); paired(oversized); oversized.peers[0].emit({received: {name: 'big', blob: new Blob([new Uint8Array(8193)])}});
  assert.equal(oversized.blobs.length, 0); assert.match(oversized.root.textContent, /受信上限/); assert.equal(button(oversized, '受信した変更の内容を確認'), undefined);
  const wait = deferred(), view = fixture(t, {onReceiveFile: async () => wait.promise}); await host(view); paired(view); view.peers[0].emit({received: {name: 'a.json', blob: new Blob(['a'])}});
  const work = button(view, '受信した変更の内容を確認').onclick(); view.dispose(); wait.resolve(); await work;
  assert.equal(view.root.textContent, ''); assert.deepEqual(view.revoked, ['blob:received-1']);
});

test('rejected received-content staging remains unconfirmed and can be explicitly retried', async t => {
  let attempts = 0;
  const view = fixture(t, {onReceiveFile: async () => { ++attempts; throw Error('変更ファイルの宛先を確認してください。'); }}); await host(view); paired(view); view.peers[0].emit({received: {name: 'wrong.json', blob: new Blob(['wrong'])}});
  await button(view, '受信した変更の内容を確認').onclick(); assert.match(view.root.textContent, /宛先を確認/); assert.equal(button(view, '受信内容の確認画面へ渡しました'), undefined); assert.equal(attempts, 1);
  await button(view, '受信した変更の内容を確認').onclick(); assert.equal(attempts, 2);
});

test('failure is visible and never retries another relay automatically; old controls cannot restart', async t => {
  const view = fixture(t, {connect: async () => { throw Error('この接続サービスでは、このHubからの接続が許可されていません。'); }}); await view.ready;
  const old = button(view, '接続の招待を作る'); await old.onclick(); assert.match(view.root.textContent, /許可されていません/); assert.equal(view.pairs.length, 1); assert.equal(view.peers[0].closed, 1); assert.equal(view.pairs[0].closed, 1);
  old.click(); await tick(); assert.equal(view.pairs.length, 1); assert.equal(view.reads.length, 1);
});

test('late start/init and account switch cannot restore invitation or preselected File', async t => {
  const wait = deferred(), view = fixture(t, {sendFile: file(), connect: async () => wait.promise}); await view.ready;
  const work = button(view, '接続の招待を作る').onclick(); await tick(); view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed')); wait.resolve(); await work;
  assert.equal(view.root.querySelector('textarea'), null); assert.ok(view.pairs[0].closed); assert.ok(view.peers[0].closed); assert.equal(view.root.querySelector('input'), null);
  const pending = deferred(), initial = fixture(t, {invoke: async () => pending.promise}); initial.dispose(); pending.resolve(origin); await initial.ready; assert.equal(initial.root.textContent, '');
});

test('explicit retries retain caller-prepared File; peer failure revokes received data and stops the relay', async t => {
  let attempts = 0;
  const prepared = file(), view = fixture(t, {sendFile: prepared, connect: async () => { if (++attempts === 1) throw Error('回線を確認してください。'); }});
  await host(view); await button(view, '接続の招待を作る').onclick(); paired(view);
  assert.equal(button(view, 'この変更を送信申請').disabled, false); await button(view, 'この変更を送信申請').onclick(); assert.equal(view.peers[1].offered[0], prepared);
  view.peers[1].emit({received: {name: 'change.json', blob: new Blob(['a'])}}); const staleImport = button(view, '受信した変更の内容を確認');
  view.peers[1].closed = 1; view.peers[1].emit({status: '回線が終了しました。', ready: false, code: ''});
  assert.deepEqual(view.revoked, ['blob:received-1']); assert.equal(view.root.querySelector('a'), null); assert.equal(button(view, '受信した変更の内容を確認'), undefined); staleImport.click(); assert.equal(view.imported.length, 0);
  assert.match(view.root.textContent, /回線が終了/); await button(view, '接続の招待を作る').onclick(); paired(view); await button(view, 'この変更を送信申請').onclick(); assert.equal(view.peers[2].offered[0], prepared);
  button(view, '接続を終了してやり直す').click(); await button(view, '接続の招待を作る').onclick(); paired(view); assert.equal(button(view, 'この変更を送信申請').disabled, false);
});

test('TURN configuration uses existing ICE parser, requires explicit start and clears credential controls on account change', async t => {
  const view = fixture(t); await view.ready;
  field(view, 'TURN URL').value = 'turns:relay.example:5349'; field(view, 'TURN 利用者名').value = 'fixture-user'; const secret = field(view, 'TURN 認証情報'); secret.value = 'fixture-credential'; field(view, 'TURN 中継のみ使う').checked = true;
  assert.equal(view.peers.length, 0); await button(view, '接続の招待を作る').onclick();
  assert.deepEqual(view.peers[0].configuration, {iceServers: [{urls: 'stun:stun.l.google.com:19302'}, {urls: 'turns:relay.example:5349', username: 'fixture-user', credential: 'fixture-credential'}], iceTransportPolicy: 'relay'});
  assert.equal(view.reads.length, 1); view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed')); assert.equal(secret.value, '');
});

test('bad limits and invalid hub_origin never permit transfer or arbitrary destination', async t => {
  for (const value of [0, -1, 1.5, NaN, 16 * 1024 * 1024 + 1]) { const view = fixture(t, {maxFileBytes: value}); await view.ready; assert.equal(button(view, '接続の招待を作る').disabled, true); assert.equal(view.peers.length, 0); }
  for (const value of [origin + '/?unsafe=1', origin + '/path#unsafe', 'http://remote.example', 'https://user:pass@receiver.example']) { const view = fixture(t, {invoke: async () => value}); await view.ready; assert.equal(button(view, '接続の招待を作る').disabled, true); assert.equal(view.peers.length, 0); }
});

test('trusted configured Hub base URLs normalize to their origin while invitation relay values remain exact', async t => {
 for(const value of [origin+'/', origin+'/v2', 'https://RECEIVER.example/v2', 'http://localhost:3020/v2']) {
  const view=fixture(t,{invoke:async()=>value});await view.ready;
  assert.equal(button(view,'接続の招待を作る').disabled,false);
  field(view,'接続サービス').value='hub';await button(view,'接続の招待を作る').onclick();
  assert.equal(view.pairs[0].origin,new URL(value).origin);
  assert.equal(new URL(field(view,'送る招待リンク').value).searchParams.get('pairRelay'),new URL(value).origin);
 }
 const rejected=fixture(t);await guest(rejected,invitation(origin,origin+'/'));assert.equal(rejected.pairs.length,0);
});
test('receivedFileType preserves default JSON and explicit binary File bytes; other media types are rejected', async t => {
  for (const receivedFileType of [undefined, 'application/json', 'application/octet-stream']) {
    const view = fixture(t, receivedFileType === undefined ? {} : {receivedFileType}); await host(view); paired(view);
    const binary = new Uint8Array([0, 128, 255, 10]); view.peers[0].emit({received: {name: 'history.bundle', blob: new Blob([binary])}});
    await button(view, '受信した変更の内容を確認').onclick(); assert.equal(view.imported[0].type, receivedFileType ?? 'application/json'); assert.deepEqual(new Uint8Array(await view.imported[0].arrayBuffer()), binary);
  }
  for (const receivedFileType of ['text/html', '', null, 'application/octet-stream\n']) {
    const dom = new JSDOM('<main/>'); assert.throws(() => initP2PTransfer(dom.window.document.querySelector('main'), {receivedFileType})); dom.window.close();
  }
});
