import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {initResearchGitBundleTransfer} from './research-git-bundle-transfer.mjs';
import {decodeGitImportMetadataHeader, GIT_IMPORT_MAX_BUNDLE_BYTES} from './research-git-import-contract.mjs';

const projectId = 'rp_' + 'a'.repeat(32), origin = 'https://receiver.example';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const field = (view, name) => view.root.querySelector(`[aria-label="${name}"]`);
const button = (view, text) => [...view.root.querySelectorAll('button')].find(value => value.textContent === text);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const file = (size = 12, actual = size) => ({size, arrayBuffer: async () => new Uint8Array(actual).buffer});
const dto = (metadata, length, outcome) => ({...metadata, projectId, bundleBytes: length, baseTreeOid: 'd'.repeat(metadata.headOid.length), headTreeOid: 'e'.repeat(metadata.headOid.length), objectFormat: metadata.headOid.length === 40 ? 'sha1' : 'sha256', candidateBranch: 'hub-import/' + metadata.requestId, outcome});
const detail = metadata => ({projectId, baseOid: metadata.baseOid, commit: {oid: metadata.headOid, parentOids: [metadata.baseOid], subject: '変更', message: '変更\n本文', committedAt: '2026-10-04T01:02:03Z'}, files: [{path: '<img src=x>.txt', status: 'M'}], diff: '-before\n+after', truncated: false});
function fixture(t, extra = {}) {
  const dom = new JSDOM('<main></main>'), calls = [], revoked = [], blobs = [], pairs = [], comparisons = []; let index = 0, metadata;
  dom.window.URL.createObjectURL = blob => { blobs.push(blob.size); return `blob:bundle-${blobs.length}`; }; dom.window.URL.revokeObjectURL = value => revoked.push(value);
  const context = {projectId, viewerId: 'owner', canManage: true, repositoryVisibility: 'confidential', projectPublic: true, randomUUID: () => `12345678-abcd-1234-abcd-123456789ab${++index}`, onImportedComparison: async value => { comparisons.push(value); },
    invoke: async (name, args, options) => {
      calls.push({name, args, options});
      if (extra.invoke) return extra.invoke(name, args, options);
      if (name === 'hub_origin') return origin;
      if (name === 'research_git_bundle') return new Uint8Array(12).buffer;
      if (name === 'research_git_bundle_import') { metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); return dto(metadata, args.byteLength, options.headers['x-hub-git-import-operation'] === 'preview' ? 'preview' : 'imported'); }
      if (name === 'research_git_bundle_check') { const {bundleSha256, ...identity} = args.metadata; return {...identity, projectId, candidateBranch: 'hub-import/' + identity.requestId, currentOid: identity.headOid, outcome: 'imported'}; }
      if (name === 'hub_detail') return detail(metadata);
      throw Error('unexpected_command');
    },
    createP2P: (target, options) => { const root = dom.window.document.createElement('section'); root.textContent = 'P2P fixture'; target.append(root); const pair = {root, options, ready: Promise.resolve(), disposed: 0, dispose() { ++this.disposed; root.replaceChildren(); }}; pairs.push(pair); return pair; }, ...extra,
  };
  // Keep recording the invoked body even when a custom response is supplied.
  const customInvoke = extra.invoke; if (customInvoke) context.invoke = async (...args) => { calls.push({name: args[0], args: args[1], options: args[2]}); return customInvoke(...args); };
  const view = initResearchGitBundleTransfer(dom.window.document.querySelector('main'), context);
  t.after(() => { view.dispose(); dom.window.close(); }); return {...view, dom, calls, revoked, blobs, pairs, comparisons, context};
}
async function select(view, value = file()) { const input = field(view, '受け取ったGit履歴ファイル'); Object.defineProperty(input, 'files', {configurable: true, value: value ? [value] : []}); await input.onchange(); }
function pairFields(view, width = 40) { field(view, '基準版の完全OID').value = 'a'.repeat(width); field(view, '変更後の完全OID').value = 'b'.repeat(width); field(view, '基準版の完全OID').oninput(); }
async function preview(view, width = 40) { await view.ready; await select(view); pairFields(view, width); await button(view, '受信履歴の情報を確認').onclick(); }
const imports = view => view.calls.filter(value => value.name === 'research_git_bundle_import');

test('initialization and file selection perform no import write, hash actual bytes and separate preview from save', async t => {
  const view = fixture(t); await view.ready; assert.deepEqual(view.calls.map(value => value.name), ['hub_origin']);
  await select(view); assert.equal(imports(view).length, 0); assert.match(view.root.textContent, new RegExp(createHash('sha256').update(new Uint8Array(12)).digest('hex')));
  pairFields(view); await button(view, '受信履歴の情報を確認').onclick();
  assert.equal(imports(view).length, 1); assert.equal(imports(view)[0].options.headers['x-hub-git-import-operation'], 'preview'); assert.ok(imports(view)[0].args instanceof Uint8Array);
  assert.match(view.root.textContent, /まだ保存していません/); assert.match(view.root.textContent, /差分の確認は保存後/); assert.ok(button(view, '確認して候補履歴を保存')); assert.equal(view.root.querySelector('pre'), null); assert.equal(view.comparisons.length, 0);
});

test('SHA1/SHA256 preview-save-check-comparison use immutable exact metadata and a separate proposal handoff', async t => {
  for (const width of [40, 64]) {
    const view = fixture(t); await preview(view, width); const fixed = imports(view)[0].options.headers['x-hub-git-import'];
    await button(view, '確認して候補履歴を保存').onclick(); assert.equal(imports(view).length, 2); assert.equal(imports(view)[1].options.headers['x-hub-git-import'], fixed); assert.deepEqual(imports(view)[1].args, imports(view)[0].args);
    assert.equal(imports(view)[1].options.headers['x-hub-git-import-operation'], 'save'); assert.equal(button(view, '確認して候補履歴を保存'), undefined);
    assert.match(view.root.textContent, /候補ブランチに履歴を保存/); assert.equal(view.comparisons.length, 0);
    await button(view, '候補の現在状態を確認').onclick(); await button(view, '受信Hubで二版の差分を取得').onclick();
    assert.equal(view.comparisons.length, 0); assert.match(view.root.querySelector('pre').textContent, /-before/); assert.equal(view.root.querySelector('img'), null);
    assert.deepEqual(view.calls.find(value => value.name === 'hub_detail').args, {name: 'research_git_compare', ids: [projectId, 'b'.repeat(width), 'a'.repeat(width)]});
    await button(view, 'この二版を提案画面へ').onclick(); assert.equal(view.comparisons.length, 1); assert.equal(view.comparisons[0].baseOid.length, width); assert.ok(button(view, '二版の比較を提案画面へ渡しました').disabled);
  }
});

test('received repo visibility explains public candidate history; no branch update, approval, credential or URL command is sent', async t => {
  const view = fixture(t, {repositoryVisibility: 'public'}); await preview(view);
  assert.match(view.root.textContent, /候補ブランチに追加した全履歴も公開範囲/); await button(view, '確認して候補履歴を保存').onclick();
  assert.ok(view.calls.every(value => ['hub_origin', 'research_git_bundle_import'].includes(value.name)));
  assert.deepEqual(Object.keys(imports(view)[0].options.headers).sort(), ['x-hub-git-import', 'x-hub-git-import-operation', 'x-hub-project-id']);
});

test('file size boundaries 0/16MiB/16MiB+1/50MiB/50MiB+1 use actual bytes and keep P2P capped', async t => {
  for (const size of [0, 1, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1, GIT_IMPORT_MAX_BUNDLE_BYTES, GIT_IMPORT_MAX_BUNDLE_BYTES + 1]) {
    const view = fixture(t); await view.ready; let reads = 0; await select(view, {size, arrayBuffer: async () => { ++reads; return new Uint8Array(size).buffer; }});
    const valid = size > 0 && size <= GIT_IMPORT_MAX_BUNDLE_BYTES; assert.equal(!!button(view, '受信履歴の情報を確認'), valid); assert.equal(reads, valid ? 1 : 0);
    if (valid) assert.equal(!!button(view, 'この履歴を端末間で渡す'), size <= 16 * 1024 * 1024);
    if (size > 16 * 1024 * 1024 && valid) assert.match(view.root.textContent, /保存したファイルを受信Hubで選択/);
    view.dispose();
  }
  for (const sample of [file(3, 2), file(3, 4), {size: NaN}, {size: 1.5}, {size: 1, arrayBuffer: async () => new Uint8Array(1)}]) { const view = fixture(t); await view.ready; await select(view, sample); assert.equal(button(view, '受信履歴の情報を確認'), undefined); assert.equal(imports(view).length, 0); }
});

test('input changes invalidate preview/requestId and stale save controls cannot write', async t => {
  const view = fixture(t); await preview(view); const old = button(view, '確認して候補履歴を保存'), first = decodeGitImportMetadataHeader(imports(view)[0].options.headers['x-hub-git-import']);
  field(view, '対象ブランチ').value = '研究/候補'; field(view, '対象ブランチ').oninput(); old.click(); assert.equal(imports(view).length, 1); assert.equal(button(view, '確認して候補履歴を保存'), undefined);
  await button(view, '受信履歴の情報を確認').onclick(); const next = decodeGitImportMetadataHeader(imports(view)[1].options.headers['x-hub-git-import']); assert.notEqual(next.requestId, first.requestId); assert.equal(next.branch, '研究/候補');
});

test('unknown save preserves request identity, locks fields, performs only check and never claims not_imported means unsaved', async t => {
  let first;
  const view = fixture(t, {invoke: async (name, args, options) => {
    if (name === 'hub_origin') return origin;
    if (name === 'research_git_bundle_import') { const metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); first ??= metadata; if (options.headers['x-hub-git-import-operation'] === 'save') throw Error('lost_response'); return dto(metadata, args.byteLength, 'preview'); }
    if (name === 'research_git_bundle_check') { const {bundleSha256, ...identity} = args.metadata; return {...identity, projectId, candidateBranch: 'hub-import/' + identity.requestId, currentOid: null, outcome: 'not_imported'}; }
  }});
  await preview(view); await button(view, '確認して候補履歴を保存').onclick(); assert.match(view.root.textContent, /保存結果は不明/); assert.ok(field(view, '対象ブランチ').disabled); assert.ok(field(view, '受け取ったGit履歴ファイル').disabled);
  await select(view, file(20)); assert.equal(view.blobs.length, 1); assert.equal(button(view, '確認して候補履歴を保存'), undefined);
  await button(view, '候補の現在状態を確認').onclick(); assert.equal(imports(view).length, 2); assert.deepEqual(view.calls.find(value => value.name === 'research_git_bundle_check').args.metadata, first);
  assert.match(view.root.textContent, /未保存の証明ではありません/); assert.equal(button(view, '受信Hubで二版の差分を取得'), undefined);
  button(view, 'この履歴の操作を終了').click(); assert.deepEqual(view.revoked, ['blob:bundle-1']); assert.equal(field(view, '対象ブランチ'), null); assert.equal(imports(view).length, 2);
});

test('save timeout keeps operation unknown and late ACK cannot restore a closed view', async t => {
  const pending = deferred(); let metadata;
  const view = fixture(t, {invoke: async (name, args, options) => { if (name === 'hub_origin') return origin; metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); return options.headers['x-hub-git-import-operation'] === 'preview' ? dto(metadata, args.byteLength, 'preview') : pending.promise; }}); await preview(view);
  t.mock.timers.enable({apis: ['setTimeout']}); const work = button(view, '確認して候補履歴を保存').onclick(); for (let i = 0; i < 20; ++i) await Promise.resolve(); t.mock.timers.tick(60000); await work; t.mock.timers.reset();
  assert.match(view.root.textContent, /保存結果は不明/); assert.equal(button(view, '確認して候補履歴を保存'), undefined); view.dispose(); pending.resolve(dto(metadata, 12, 'imported')); await tick(); assert.equal(view.root.textContent, '');
});

test('save mismatch/refusal retains frozen attempt as unknown and protects against resubmit', async t => {
  for (const mode of ['refusal', 'identity', 'bytes', 'tree']) {
    const view = fixture(t, {invoke: async (name, args, options) => { if (name === 'hub_origin') return origin; const metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); if (options.headers['x-hub-git-import-operation'] === 'preview') return dto(metadata, args.byteLength, 'preview'); if (mode === 'refusal') throw Error('rejected:403'); return {...dto(metadata, args.byteLength, 'imported'), ...(mode === 'identity' ? {requestId: '12345678-abcd-1234-abcd-123456789aff'} : mode === 'bytes' ? {bundleBytes: 13} : {headTreeOid: 'f'.repeat(40)})}; }});
    await preview(view); await button(view, '確認して候補履歴を保存').onclick(); assert.match(view.root.textContent, /保存結果は不明/); assert.equal(button(view, '確認して候補履歴を保存'), undefined); assert.equal(imports(view).length, 2);
  }
});

test('wrong-width/same OIDs, invalid branch and nonowner never send preview/save', async t => {
  for (const change of [{branch: 'bad..name'}, {base: 'a'.repeat(39)}, {head: 'b'.repeat(64)}, {head: 'a'.repeat(40)}, {branch: 'あ'.repeat(67)}]) {
    const view = fixture(t); await view.ready; await select(view); pairFields(view); for (const [key, value] of Object.entries(change)) field(view, {branch: '対象ブランチ', base: '基準版の完全OID', head: '変更後の完全OID'}[key]).value = value;
    await button(view, '受信履歴の情報を確認').onclick(); assert.equal(imports(view).length, 0); assert.equal(button(view, '確認して候補履歴を保存'), undefined);
  }
  for (const scope of [{canManage: false}, {viewerId: null}, {projectId: 'wrong'}]) { const view = fixture(t, scope); await view.ready; assert.equal(field(view, '受け取ったGit履歴ファイル'), null); assert.equal(button(view, '端末間でGit履歴を受け取る'), undefined); }
});

test('account/dispose/context/origin changes discard bytes, URLs, private fields and late preview response', async t => {
  for (const mode of ['account', 'dispose', 'context', 'origin']) {
    const pending = deferred(); let reads = 0, metadata;
    const view = fixture(t, {invoke: async (name, args, options) => { if (name === 'hub_origin') return mode === 'origin' && ++reads > 1 ? 'https://other.example' : origin; metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); return pending.promise; }}); await view.ready; await select(view); pairFields(view);
    const baseField = field(view, '基準版の完全OID'), work = button(view, '受信履歴の情報を確認').onclick(); await tick();
    if (mode === 'account') view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed'));
    if (mode === 'dispose') view.dispose();
    if (mode === 'context') { view.context.projectId = 'rp_' + 'f'.repeat(32); baseField.oninput(); }
    pending.resolve(metadata ? dto(metadata, 12, 'preview') : null); await work;
    assert.equal(view.root.querySelector('a'), null); assert.equal(button(view, '確認して候補履歴を保存'), undefined); assert.deepEqual(view.revoked, ['blob:bundle-1']); assert.equal(baseField.value, '');
  }
});

test('P2P uses octet-stream, explicit staging and URL change closes older sender; >16MiB keeps file route', async t => {
  const view = fixture(t); await view.ready; await button(view, '端末間でGit履歴を受け取る').onclick(); const receiver = view.pairs[0]; assert.equal(receiver.options.receivedFileType, 'application/octet-stream'); assert.equal(receiver.options.maxFileBytes, 16 * 1024 * 1024);
  assert.equal(imports(view).length, 0); await receiver.options.onReceiveFile(file()); assert.equal(imports(view).length, 0); assert.ok(button(view, '受信履歴の情報を確認'));
  button(view, '履歴の送受信画面を閉じる').click(); assert.equal(receiver.disposed, 1);
  field(view, '端末間送信の受信先プロジェクトURL').value = 'https://sender-target.example/v2/research/rp_' + 'b'.repeat(32); field(view, '端末間送信の受信先プロジェクトURL').oninput(); await button(view, 'この履歴を端末間で渡す').onclick();
  const sender = view.pairs[1]; assert.equal(sender.options.invitationUrl, 'https://sender-target.example/v2/research/rp_' + 'b'.repeat(32) + '?gitBundle=1'); assert.equal(sender.options.sendFile.type, 'application/octet-stream'); assert.equal(sender.options.sendFile.size, 12); assert.equal(view.calls.filter(value => value.name !== 'hub_origin').length, 0);
  field(view, '端末間送信の受信先プロジェクトURL').value = 'https://next.example/v2/research/rp_' + 'c'.repeat(32); field(view, '端末間送信の受信先プロジェクトURL').oninput(); assert.equal(sender.disposed, 1); assert.equal(sender.options.isCurrent(), false);
  view.invalidate(); assert.equal(view.root.querySelector('input'), null);
});

test('pending byte read is dropped on account change', async t => {
  const pending = deferred(), view = fixture(t); await view.ready; const input = field(view, '受け取ったGit履歴ファイル'); Object.defineProperty(input, 'files', {value: [{size: 12, arrayBuffer: () => pending.promise}]}); const work = input.onchange(); view.invalidate(); pending.resolve(new Uint8Array(12).buffer); await work; assert.equal(view.blobs.length, 0); assert.equal(view.root.querySelector('a'), null);
});

test('P2P receiver cannot replace unknown-save bytes or request identity', async t => {
  const view = fixture(t, {invoke: async (name, args, options) => { if (name === 'hub_origin') return origin; const metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); if (options.headers['x-hub-git-import-operation'] === 'save') throw Error('lost'); return dto(metadata, args.byteLength, 'preview'); }});
  await view.ready; await button(view, '端末間でGit履歴を受け取る').onclick(); const receiver = view.pairs[0]; await receiver.options.onReceiveFile(file()); pairFields(view); await button(view, '受信履歴の情報を確認').onclick(); await button(view, '確認して候補履歴を保存').onclick();
  const header = imports(view)[1].options.headers['x-hub-git-import']; await assert.rejects(receiver.options.onReceiveFile(file(20))); assert.equal(view.blobs.length, 1); assert.equal(imports(view).length, 2); assert.equal(imports(view)[1].options.headers['x-hub-git-import'], header); assert.match(view.root.textContent, /保存結果は不明/);
});

test('explicit public download is fixed JSON IPC and protected repo cannot download; malformed response exposes no file', async t => {
  const view = fixture(t, {repositoryVisibility: 'public'}); await view.ready; assert.equal(view.calls.length, 1); await button(view, '公開Git履歴を取得').onclick(); assert.deepEqual(view.calls.find(value => value.name === 'research_git_bundle').args, {projectId}); assert.equal(imports(view).length, 0); assert.ok(view.root.querySelector('a'));
  const privateView = fixture(t); await privateView.ready; assert.equal(button(privateView, '公開Git履歴を取得'), undefined);
  const bad = fixture(t, {repositoryVisibility: 'public', invoke: async name => name === 'hub_origin' ? origin : new Uint8Array(12)}); await bad.ready; await button(bad, '公開Git履歴を取得').onclick(); assert.equal(bad.root.querySelector('a'), null);
});

test('fresh comparison mismatch is rejected and existing proposal draft refusal does not mark handoff complete', async t => {
  const view = fixture(t, {onImportedComparison: async () => false}); await preview(view); await button(view, '確認して候補履歴を保存').onclick(); await button(view, '受信Hubで二版の差分を取得').onclick(); await button(view, 'この二版を提案画面へ').onclick(); assert.match(view.root.textContent, /既存の下書き/); assert.equal(button(view, '二版の比較を提案画面へ渡しました'), undefined);
  let metadata;
  const wrong = fixture(t, {invoke: async (name, args, options) => { if (name === 'hub_origin') return origin; if (name === 'research_git_bundle_import') { metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); return dto(metadata, args.byteLength, options.headers['x-hub-git-import-operation'] === 'preview' ? 'preview' : 'imported'); } return {...detail(metadata), baseOid: 'f'.repeat(40)}; }}); await preview(wrong); await button(wrong, '確認して候補履歴を保存').onclick(); await button(wrong, '受信Hubで二版の差分を取得').onclick(); assert.equal(button(wrong, 'この二版を提案画面へ'), undefined);
});

test('owned stage bytes and raw IPC clones are zeroed on replacement, completion and account loss', async t => {
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle), hashes = [];
  t.mock.method(crypto.subtle, 'digest', (algorithm, buffer) => { hashes.push(buffer); return nativeDigest(algorithm, buffer); });
  const pending = deferred();
  const view = fixture(t, {invoke: async (name, args, options) => { if (name === 'hub_origin') return origin; const metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); return options.headers['x-hub-git-import-operation'] === 'preview' ? dto(metadata, args.byteLength, 'preview') : pending.promise; }}); await view.ready;
  await select(view, {size: 3, arrayBuffer: async () => new Uint8Array([3, 4, 5]).buffer}); assert.deepEqual(new Uint8Array(hashes[0]), new Uint8Array([3, 4, 5]));
  await select(view, {size: 3, arrayBuffer: async () => new Uint8Array([6, 7, 8]).buffer}); assert.deepEqual(new Uint8Array(hashes[0]), new Uint8Array(3));
  pairFields(view); await button(view, '受信履歴の情報を確認').onclick(); assert.deepEqual(imports(view)[0].args, new Uint8Array(3));
  const work = button(view, '確認して候補履歴を保存').onclick(); await tick(); const upload = imports(view)[1].args; assert.deepEqual(upload, new Uint8Array([6, 7, 8]));
  view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed')); assert.deepEqual(upload, new Uint8Array(3)); assert.deepEqual(new Uint8Array(hashes[1]), new Uint8Array(3)); await work;
  const metadata = decodeGitImportMetadataHeader(imports(view)[1].options.headers['x-hub-git-import']); pending.resolve(dto(metadata, 3, 'imported')); await tick(); assert.equal(button(view, 'この二版を提案画面へ'), undefined);
});

test('a late hash result purges its private staging copy and never exposes a download', async t => {
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle), pending = deferred(); let copy;
  t.mock.method(crypto.subtle, 'digest', async (algorithm, buffer) => { copy = buffer; const value = await nativeDigest(algorithm, buffer); await pending.promise; return value; });
  const view = fixture(t); await view.ready; const work = select(view, {size: 3, arrayBuffer: async () => new Uint8Array([6, 7, 8]).buffer}); await tick(); view.invalidate(); pending.resolve(); await work;
  assert.deepEqual(new Uint8Array(copy), new Uint8Array(3)); assert.equal(view.blobs.length, 0); assert.equal(view.root.querySelector('a'), null);
});

test('proposal handoff independently rechecks current Hub and discards an origin change', async t => {
  let currentOrigin = origin, metadata, handoffs = 0;
  const view = fixture(t, {onImportedComparison: async () => { ++handoffs; }, invoke: async (name, args, options) => { if (name === 'hub_origin') return currentOrigin; if (name === 'research_git_bundle_import') { metadata = decodeGitImportMetadataHeader(options.headers['x-hub-git-import']); return dto(metadata, args.byteLength, options.headers['x-hub-git-import-operation'] === 'preview' ? 'preview' : 'imported'); } return detail(metadata); }});
  await preview(view); await button(view, '確認して候補履歴を保存').onclick(); await button(view, '受信Hubで二版の差分を取得').onclick(); currentOrigin = 'https://changed.example'; await button(view, 'この二版を提案画面へ').onclick();
  assert.equal(handoffs, 0); assert.equal(view.root.querySelector('a'), null); assert.equal(view.root.querySelector('pre'), null); assert.deepEqual(view.revoked, ['blob:bundle-1']);
});
