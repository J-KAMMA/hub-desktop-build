import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchGitChangeExport, researchGitChangeImport} from './research-git-change-transfer.mjs';
import {createResearchGitChangePackage, parseResearchGitChangePackage} from './research-git-change-package.mjs';

const projectId = `rp_${'a'.repeat(32)}`, origin = 'https://receiver.example', baseOid = 'b'.repeat(40), headOid = 'c'.repeat(40);
const comparison = () => ({projectId, baseOid, commit: {oid: headOid, parentOids: [baseOid], subject: '変更', message: '変更\n本文', committedAt: '2026-10-04T01:02:03Z'}, files: [{path: 'src/a.txt', status: 'M'}], diff: '-before\n+after', truncated: false});
const inputPackage = () => ({protocol: 'hub.research-git-change.v1', target: {origin, projectId}, baseOid, headOid, title: '<img src=x>題', summary: '私的な変更理由'});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, text) => [...root.querySelectorAll('button')].find(element => element.textContent === text);
const field = (root, label) => root.querySelector(`[aria-label="${label}"]`);
const file = (value, extra = {}) => { const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)); return {size: bytes.length, arrayBuffer: async () => bytes.buffer, ...extra}; };
function fixture(kind = 'import', options = {}, context = {}) {
  const dom = new JSDOM('<main></main>'), target = dom.window.document.querySelector('main'), reads = [], copied = [], blobs = [], revoked = [], handoffs = [];
  const account = {projectId, signedIn: true, ...context};
  const actions = {invoke: async (name, args) => { reads.push({name, args}); return name === 'hub_origin' ? origin : comparison(); },
    onImport: async value => { copied.push(value); }, createObjectURL: blob => { blobs.push(blob); return `blob:scoped-${blobs.length}`; }, revokeObjectURL: url => revoked.push(url), createP2P: (host, config) => { handoffs.push(config); return {ready: Promise.resolve(), dispose: () => handoffs.push('disposed')}; }, ...options};
  const view = kind === 'import' ? researchGitChangeImport(target, account, actions) : researchGitChangeExport(target, {comparison: comparison(), title: inputPackage().title, summary: inputPackage().summary}, actions);
  return {...view, dom, account, reads, copied, blobs, revoked, handoffs};
}
async function select(view, value) {
  const input = field(view.root, '受信した変更ファイル'); Object.defineProperty(input, 'files', {configurable: true, value: value ? [value] : []});
  return input.onchange();
}
async function previewExport(view) {
  field(view.root, '受信先プロジェクトのURL').value = `${origin}/v2/research/${projectId}#git`;
  await button(view.root, '持ち出す内容を確認').onclick();
}
const blobText = (view, blob) => new Promise((resolve, reject) => { const reader = new view.dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob); });

test('export previews metadata literally; explicit confirmation prepares bounded hash-verified file and Native transfer receives only the explicitly confirmed bounded file', async () => {
  const view = fixture('export'); await view.ready;
  assert.deepEqual(view.reads, []); assert.deepEqual(view.blobs, []); assert.deepEqual(view.handoffs, []);
  await previewExport(view);
  assert.equal(view.root.querySelector('img'), null); assert.match(view.root.textContent, /私的な変更理由/);
  assert.match(view.root.textContent, /私的な提案理由/); assert.match(view.root.textContent, /送付者・出自・承認権限を証明しません/);
  assert.deepEqual(view.blobs, []); assert.equal(view.root.querySelector('a'), null);
  button(view.root, '確認してファイルを準備').click();
  assert.equal(view.blobs.length, 1); assert.ok(view.blobs[0].size <= 8192);
  const packet = await parseResearchGitChangePackage(JSON.parse(await blobText(view, view.blobs[0])));
  assert.deepEqual({...packet, contentHash: undefined}, {...inputPackage(), contentHash: undefined});
  const link = view.root.querySelector('a'); assert.equal(link.getAttribute('href'), 'blob:scoped-1'); assert.equal(link.download, 'research-git-change.json');
  assert.deepEqual(view.reads, []); assert.deepEqual(view.handoffs, []);
  await button(view.root, 'このファイルを端末間で渡す').onclick(); assert.equal(view.handoffs.length, 1);
  const config = view.handoffs[0]; assert.equal(config.maxFileBytes, 8192); assert.equal(config.invitationUrl, `${origin}/v2/research/${projectId}`);
  assert.deepEqual(JSON.parse(await config.sendFile.text()), packet); assert.equal(config.sendFile.name, 'research-git-change.json');
  view.dispose(); assert.deepEqual(view.revoked, ['blob:scoped-1']); assert.equal(view.root.querySelector('a'), null);
  assert.equal(view.handoffs.at(-1), 'disposed');
});

test('export edit revokes prepared URL and stale confirmation or download cannot prepare or expose a newer draft', async () => {
  const view = fixture('export'); await previewExport(view);
  const stale = button(view.root, '確認してファイルを準備'); stale.click(); const oldLink = view.root.querySelector('a');
  const reason = field(view.root, '持ち出す変更の理由'); reason.value = '変更した理由'; reason.oninput();
  assert.deepEqual(view.revoked, ['blob:scoped-1']); assert.equal(view.root.querySelector('a'), null); assert.equal(button(view.root, '確認してファイルを準備'), undefined);
  await previewExport(view); stale.click(); assert.equal(view.blobs.length, 1);
  const event = new view.dom.window.MouseEvent('click', {cancelable: true}); oldLink.onclick(event); assert.equal(event.defaultPrevented, true);
  button(view.root, '確認してファイルを準備').click(); view.invalidate();
  assert.deepEqual(view.revoked, ['blob:scoped-1', 'blob:scoped-2']); assert.doesNotMatch(view.root.textContent, /私的|変更した理由/);
});

test('export invalid comparison or destination produces no file, invoke, or Web handoff', async () => {
  const view = fixture('export'); field(view.root, '受信先プロジェクトのURL').value = `https://user:secret@receiver.example/v2/research/${projectId}`;
  await button(view.root, '持ち出す内容を確認').onclick(); assert.match(view.root.textContent, /宛先URL/); assert.deepEqual(view.blobs, []); assert.deepEqual(view.reads, []);
  const dom = new JSDOM('<main/>'), invalid = researchGitChangeExport(dom.window.document.querySelector('main'), {comparison: {...comparison(), baseOid: headOid}});
  assert.match(invalid.root.textContent, /二版の比較を確認できません/); assert.equal(button(invalid.root, '持ち出す内容を確認').disabled, true); invalid.dispose(); view.dispose();
});

test('export hash completion cannot restore an edited preview or a disposed view', async () => {
  for (const mode of ['edited', 'dispose', 'event']) {
    const view = fixture('export'); field(view.root, '受信先プロジェクトのURL').value = `${origin}/v2/research/${projectId}`;
    const work = button(view.root, '持ち出す内容を確認').onclick();
    if (mode === 'edited') { const subject = field(view.root, '持ち出す提案の題'); subject.value = '新しい題'; subject.oninput(); }
    if (mode === 'dispose') view.dispose();
    if (mode === 'event') view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed'));
    await work; assert.equal(view.root.querySelector('[aria-label="変更ファイルの確認"]'), null); assert.deepEqual(view.blobs, []); assert.deepEqual(view.reads, []); view.dispose();
  }
});

test('export account loss or dispose revokes URL and blocks explicit handoff', async () => {
  for (const mode of ['event', 'current', 'dispose']) {
    let current = true; const view = fixture('export', {isCurrent: () => current}); await previewExport(view); button(view.root, '確認してファイルを準備').click();
    const old = button(view.root, 'このファイルを端末間で渡す');
    if (mode === 'event') view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed'));
    if (mode === 'current') current = false;
    if (mode === 'dispose') view.dispose();
    old.click(); assert.deepEqual(view.handoffs, []); assert.deepEqual(view.revoked, ['blob:scoped-1']); assert.equal(view.root.querySelector('a'), null);
  }
});

test('file selection is metadata only; explicit import fetches exact receiving pair and calls existing form once', async () => {
  const packet = await createResearchGitChangePackage(inputPackage()), view = fixture(); await view.ready; await select(view, file(packet));
  assert.deepEqual(view.reads, []); assert.deepEqual(view.copied, []); assert.equal(view.root.querySelector('img'), null); assert.match(view.root.textContent, /私的な変更理由/);
  const confirm = button(view.root, '提案フォームへ取り込む'); await confirm.onclick(); confirm.click();
  assert.deepEqual(view.reads, [{name: 'hub_origin', args: undefined}, {name: 'hub_detail', args: {name: 'research_git_compare', ids: [projectId, headOid, baseOid]}}]);
  assert.deepEqual(view.copied, [{comparison: comparison(), title: packet.title, summary: packet.summary}]);
  assert.match(view.root.textContent, /提案フォームへ取り込みました/); assert.equal(button(view.root, '提案フォームへ取り込む').disabled, true);
  assert.ok(view.reads.every(({name}) => name !== 'hub_client_action')); view.dispose();
});

test('malformed, tampered, invalid UTF8, and oversized actual bytes cannot stage a file', async () => {
  const packet = await createResearchGitChangePackage(inputPackage());
  for (const source of [file('{'), file({...packet, title: '改ざん'}), file({...packet, extra: 'forbidden'}), file('', {size: 0, arrayBuffer: async () => new Uint8Array([0xc0, 0xaf]).buffer}), file('', {size: 0, arrayBuffer: async () => new Uint8Array(8193).buffer}), file(packet, {size: 8193})]) {
    const view = fixture(); await select(view, source); assert.match(view.root.textContent, /形式・ハッシュ・8KiB/); assert.equal(button(view.root, '提案フォームへ取り込む'), undefined); assert.deepEqual(view.reads, []); assert.deepEqual(view.copied, []); view.dispose();
  }
});

test('destination project and origin must both match; identity mismatch never reads Git or invokes callback', async () => {
  const packet = await createResearchGitChangePackage(inputPackage());
  for (const mode of ['project', 'origin', 'credentials', 'path']) {
    const reads = [], view = fixture('import', {invoke: async (name, args) => { reads.push({name, args}); return mode === 'credentials' ? 'https://user:pass@receiver.example' : mode === 'path' ? `${origin}/path` : 'https://other.example'; }}, mode === 'project' ? {projectId: `rp_${'d'.repeat(32)}`} : {});
    await select(view, file(packet)); await button(view.root, '提案フォームへ取り込む').onclick();
    assert.match(view.root.textContent, /宛先Hub・プロジェクト/); assert.ok(reads.every(row => row.name === 'hub_origin')); assert.equal(reads.length, mode === 'project' ? 0 : 1); assert.deepEqual(view.copied, []); view.dispose();
  }
});

test('receiving comparison must match project, head and base and response bounds; absent public objects show restoration guide', async () => {
  const packet = await createResearchGitChangePackage(inputPackage());
  const invalid = [{...comparison(), projectId: 'other'}, {...comparison(), baseOid: 'd'.repeat(40)}, {...comparison(), commit: {...comparison().commit, oid: 'd'.repeat(40)}}, {...comparison(), diff: 'x'.repeat(100001)}, null];
  for (const payload of invalid) {
    const view = fixture('import', {invoke: async name => { if (name === 'hub_origin') return origin; if (payload === null) throw Error('404'); return payload; }});
    await select(view, file(packet)); await button(view.root, '提案フォームへ取り込む').onclick(); assert.deepEqual(view.copied, []);
    assert.match(view.root.textContent, /公開比較を確認できない/); assert.match(view.root.textContent, /Git bundle.*候補ブランチ.*元のIDと異なる/); view.dispose();
  }
});

test('double click stays within one receiver read and one import; protected draft can reject without success notice', async () => {
  const packet = await createResearchGitChangePackage(inputPackage()), gate = deferred(), reads = [];
  const view = fixture('import', {invoke: async (name, args) => { reads.push({name, args}); return name === 'hub_origin' ? gate.promise : comparison(); }, onImport: () => false});
  await select(view, file(packet)); const confirm = button(view.root, '提案フォームへ取り込む'); const work = confirm.onclick(); confirm.click();
  assert.equal(reads.length, 1); gate.resolve(origin); await work;
  assert.equal(reads.length, 2); assert.match(view.root.textContent, /下書きや保存中の操作を保護/); assert.doesNotMatch(view.root.textContent, /提案フォームへ取り込みました/); view.dispose();
});

test('signed-out controls never parse or invoke, and runtime account loss prevents callbacks', async () => {
  const packet = await createResearchGitChangePackage(inputPackage()), signedOut = fixture('import', {}, {signedIn: false});
  assert.equal(field(signedOut.root, '受信した変更ファイル').disabled, true); assert.match(signedOut.root.textContent, /ログイン/); await select(signedOut, file(packet)); assert.deepEqual(signedOut.reads, []); assert.deepEqual(signedOut.copied, []);
  const view = fixture(); await select(view, file(packet)); view.account.signedIn = false; button(view.root, '提案フォームへ取り込む').click(); assert.deepEqual(view.reads, []); assert.deepEqual(view.copied, []); assert.doesNotMatch(view.root.textContent, /私的な変更理由/);
});

test('dispose, account event or current-owner loss while origin is delayed prevents comparison read and callback', async () => {
  const packet = await createResearchGitChangePackage(inputPackage());
  for (const mode of ['dispose', 'event', 'current', 'signedIn']) {
    const gate = deferred(), reads = []; let current = true;
    const view = fixture('import', {isCurrent: () => current, invoke: (name, args) => { reads.push({name, args}); return gate.promise; }});
    await select(view, file(packet)); const work = button(view.root, '提案フォームへ取り込む').onclick();
    if (mode === 'dispose') view.dispose(); if (mode === 'event') view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed')); if (mode === 'current') current = false; if (mode === 'signedIn') view.account.signedIn = false;
    gate.resolve(origin); await work; assert.equal(reads.length, 1); assert.deepEqual(view.copied, []); assert.doesNotMatch(view.root.textContent, /私的な変更理由/); view.dispose();
  }
});

test('late comparison cannot invoke form callback after account loss or a newer file selection', async () => {
  const packet = await createResearchGitChangePackage(inputPackage());
  for (const mode of ['dispose', 'event', 'current', 'new-file']) {
    const gate = deferred(); let current = true;
    const view = fixture('import', {isCurrent: () => current, invoke: async name => name === 'hub_origin' ? origin : gate.promise});
    await select(view, file(packet)); const work = button(view.root, '提案フォームへ取り込む').onclick(); await tick();
    if (mode === 'dispose') view.dispose(); if (mode === 'event') view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed')); if (mode === 'current') current = false;
    if (mode === 'new-file') await select(view, file(await createResearchGitChangePackage({...inputPackage(), title: '新しい題'})));
    gate.resolve(comparison()); await work; assert.deepEqual(view.copied, []); assert.doesNotMatch(view.root.textContent, /提案フォームへ取り込みました/); view.dispose();
  }
});

test('late file read cannot stage metadata after dispose or replace newer file', async () => {
  const packet = await createResearchGitChangePackage(inputPackage()), gate = deferred(), view = fixture();
  const work = select(view, file(packet, {arrayBuffer: () => gate.promise}));
  await select(view, file(await createResearchGitChangePackage({...inputPackage(), title: '最新のファイル'})));
  gate.resolve(new TextEncoder().encode(JSON.stringify(packet)).buffer); await work;
  assert.match(view.root.textContent, /最新のファイル/); assert.doesNotMatch(view.root.textContent, /<img/); assert.deepEqual(view.reads, []);
  const later = deferred(), stale = select(view, file(packet, {arrayBuffer: () => later.promise})); view.dispose(); later.resolve(new TextEncoder().encode(JSON.stringify(packet)).buffer); await stale;
  assert.equal(view.root.textContent, ''); assert.deepEqual(view.copied, []);
});

test('async import acknowledgment after invalidation cannot restore preview or success notice', async () => {
  const packet = await createResearchGitChangePackage(inputPackage()), gate = deferred(); let calls = 0;
  const view = fixture('import', {onImport: async () => { calls++; return gate.promise; }});
  await select(view, file(packet)); const work = button(view.root, '提案フォームへ取り込む').onclick(); await tick(); assert.equal(calls, 1);
  view.invalidate(); gate.resolve(true); await work; assert.match(view.root.textContent, /接続が変わりました/); assert.doesNotMatch(view.root.textContent, /私的|取り込みました/);
});


test('P2P receive stages a bounded file, with explicit import and lifecycle cleanup', async () => {
  const packet = await createResearchGitChangePackage(inputPackage()), view = fixture();
  await button(view.root, '端末間で変更ファイルを受け取る').onclick();
  assert.equal(view.handoffs.length, 1); const config = view.handoffs[0];
  assert.equal(config.maxFileBytes, 8192); assert.deepEqual(view.reads, []); assert.deepEqual(view.copied, []);
  await config.onReceiveFile(file(packet));
  assert.deepEqual(view.reads, []); assert.deepEqual(view.copied, []);
  assert.match(view.root.textContent, /私的な変更理由/);
  await button(view.root, '提案フォームへ取り込む').onclick();
  assert.equal(view.copied.length, 1);
  view.invalidate(); await config.onReceiveFile(file(packet));
  assert.equal(view.copied.length, 1); assert.equal(config.isCurrent(), false);
  assert.equal(view.handoffs.at(-1), 'disposed'); assert.doesNotMatch(view.root.textContent, /私的/);
});

test('preparing a new export disposes the old transfer and clears the transferred file', async () => {
  const view = fixture('export'); await previewExport(view);
  button(view.root, '確認してファイルを準備').click();
  await button(view.root, 'このファイルを端末間で渡す').onclick();
  const config = view.handoffs[0];
  field(view.root, '持ち出す変更の理由').value = '新たな理由'; field(view.root, '持ち出す変更の理由').oninput();
  assert.equal(config.isCurrent(), false); assert.equal(view.handoffs.at(-1), 'disposed');
  assert.equal(button(view.root, 'このファイルを端末間で渡す'), undefined); view.dispose();
});

test('closing receive transfer prevents old callbacks and late failure from replacing a new transfer',async()=>{
 const packet=await createResearchGitChangePackage(inputPackage()), gate=deferred(), configs=[];
 let closed=0;
 const view=fixture('import',{createP2P:(host,config)=>{configs.push(config);return{ready:configs.length===1?gate.promise:Promise.resolve(),dispose:()=>closed++};}});
 const work=button(view.root,'端末間で変更ファイルを受け取る').onclick();
 button(view.root,'送受信画面を閉じる').click();
 await button(view.root,'端末間で変更ファイルを受け取る').onclick();
 await configs[0].onReceiveFile(file(packet));assert.equal(button(view.root,'提案フォームへ取り込む'),undefined);
 gate.reject(Error('old transfer'));await work;
 assert.equal(configs.length,2);assert.equal(closed,1);assert.ok(button(view.root,'送受信画面を閉じる'));
 await configs[1].onReceiveFile(file(packet));assert.ok(button(view.root,'提案フォームへ取り込む'));view.dispose();assert.equal(closed,2);
});