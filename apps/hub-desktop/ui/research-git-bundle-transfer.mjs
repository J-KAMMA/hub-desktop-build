import {GIT_IMPORT_MAX_BUNDLE_BYTES, gitImportProjectId, parseGitImportMetadata, encodeGitImportMetadataHeader, validateGitImportBundleLength, parseGitImportResult, parseGitImportCheckResult} from './research-git-import-contract.mjs';
import {parseNativeGitDetail} from './research-git-browser.mjs';
import {initP2PTransfer} from './p2p-transfer-panel.mjs';

const P2P_LIMIT = 16 * 1024 * 1024;
const node = (document, tag, text, className = '') => { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; };
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
function hubOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) throw Error('invalid_hub');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('invalid_hub');
  return url.origin;
}
function recipient(value) {
  const url = new URL(value.trim()); hubOrigin(url.origin);
  if (url.username || url.password || url.search || url.hash || /[\x00-\x20\x7f\\]/.test(value) || !/^\/v2\/research\/rp_[a-f0-9]{32}$/.test(url.pathname)) throw Error('宛先は受信先Hubの完全なプロジェクトURLを入力してください。');
  return url.href;
}

/** Bytes and operation metadata remain private to this mounted, account-bound view. */
export function initResearchGitBundleTransfer(target, options) {
  const {projectId, invoke, viewerId, canManage, repositoryVisibility, projectPublic, onImportedComparison} = options;
  const document = target.ownerDocument, window = document.defaultView, root = node(document, 'section', undefined, 'detail-form research-git-bundle-transfer');
  Object.assign(root.style, {minWidth: '0', overflowWrap: 'anywhere', gridTemplateColumns: 'minmax(0,1fr)'}); root.setAttribute('aria-label', 'Git履歴を渡す・受け取る'); target.append(root);
  const scope = () => JSON.stringify([options.projectId, options.viewerId, options.canManage, options.repositoryVisibility, options.projectPublic]);
  const initialScope = scope(), owns = gitImportProjectId(projectId) && canManage === true && typeof viewerId === 'string' && !!viewerId && ['public', 'confidential'].includes(repositoryVisibility);
  const urls = window?.URL?.createObjectURL ? window.URL : globalThis.URL;
  const branch = node(document, 'input'), base = node(document, 'input'), head = node(document, 'input'), destination = node(document, 'input'), fileInput = node(document, 'input');
  branch.value = 'main'; fileInput.type = 'file'; fileInput.accept = '.bundle,application/octet-stream'; fileInput.setAttribute('aria-label', '受け取ったGit履歴ファイル');
  for (const [label, input] of [['対象ブランチ', branch], ['基準版の完全OID', base], ['変更後の完全OID', head], ['端末間送信の受信先プロジェクトURL', destination]]) { input.type = 'text'; input.setAttribute('aria-label', label); input.autocomplete = 'off'; input.spellcheck = false; }
  for (const input of [branch, base, head, destination, fileInput]) Object.assign(input.style, {minWidth: '0', width: '100%', maxWidth: '100%', boxSizing: 'border-box'});
  let active = true, revision = 0, busy = false, origin = '', message = '', error = '', bytes = null, digest = '', url = '', packet = null, preview = null, saveSent = false, unknown = false, candidateReady = false, comparison = null, handedOff = false, pair = null;
  const pairHost = node(document, 'div'); let pairGeneration = 0;
  const cancellations = new Set(), uploads = new Set();
  const alive = () => active && initialScope === scope() && options.isCurrent?.() !== false;
  function current() { if (alive()) return true; if (active) invalidate(); return false; }
  function closePair() { ++pairGeneration; pair?.dispose(); pair = null; pairHost.replaceChildren(); }
  function releaseURL() { if (url) urls.revokeObjectURL(url); url = ''; }
  function wipeBytes() { if (bytes) new Uint8Array(bytes).fill(0); bytes = null; }
  function clearAttempt() { ++revision; closePair(); releaseURL(); wipeBytes(); digest = ''; packet = preview = comparison = null; saveSent = unknown = candidateReady = handedOff = false; fileInput.value = ''; }
  function dispose() { if (!active) return; active = false; clearAttempt(); origin = ''; branch.value = base.value = head.value = destination.value = ''; for (const upload of uploads) upload.fill(0); uploads.clear(); for (const cancel of cancellations) cancel(); cancellations.clear(); window?.removeEventListener('hub-account-changed', invalidate); root.replaceChildren(); }
  function invalidate() { dispose(); root.replaceChildren(node(document, 'p', '接続が変わりました。Git履歴の画面を開き直してください。', 'meta')); }
  const notice = (text, alert = false) => { const element = node(document, 'p', text, 'meta'); element.setAttribute('role', alert ? 'alert' : 'status'); return element; };
  function button(text, action, disabled = false) { const element = node(document, 'button', text, 'head-action'); element.type = 'button'; element.disabled = !!disabled; Object.assign(element.style, {maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'normal', justifySelf: 'start'}); element.onclick = () => { if (!element.disabled && root.contains(element) && current()) return action(); }; return element; }
  async function request(name, ...args) {
    let timer, cancel;
    try { return await Promise.race([Promise.resolve().then(() => { if (!current()) throw Error('closed'); return invoke(name, ...args); }), new Promise((_, reject) => { cancel = () => reject(Error('closed')); cancellations.add(cancel); timer = setTimeout(() => reject(Error('timeout')), 60000); })]); }
    finally { clearTimeout(timer); cancellations.delete(cancel); }
  }
  async function confirmOrigin(token) { const value = hubOrigin(await request('hub_origin')); if (!current() || token !== revision) return false; if (!origin || value !== origin) { invalidate(); return false; } return true; }
  async function importRequest(metadata, operation) {
    const upload = new Uint8Array(bytes.slice(0)); uploads.add(upload);
    try { return await request('research_git_bundle_import', upload, {headers: {'x-hub-project-id': projectId, 'x-hub-git-import': encodeGitImportMetadataHeader(metadata), 'x-hub-git-import-operation': operation}}); }
    finally { upload.fill(0); uploads.delete(upload); }
  }
  async function run(action) {
    if (!current() || busy) return;
    const token = revision; busy = true; error = ''; render();
    try { await action(token); } catch { if (current() && token === revision) error = unknown ? '保存結果は不明です。同じ操作を再送せず、候補の現在状態を確認してください。' : saveSent ? '候補の現在状態または二版の比較を確認できません。保存は再送せず、接続と権限を確認してください。' : '履歴のサイズ・入力・接続先と権限を確認してください。'; }
    finally { if (current() && token === revision) { busy = false; render(); } }
  }
  function locked() { return busy || saveSent || unknown; }
  function edited() { if (!current() || locked()) return; ++revision; packet = preview = comparison = null; candidateReady = handedOff = false; error = message = ''; render(); }
  for (const input of [branch, base, head]) input.oninput = edited;
  destination.oninput = () => { if (current() && !busy) { closePair(); error = ''; render(); } };
  async function stage(file, fromPair = false) {
    if (!current() || locked() || !owns) return false;
    if (!fromPair) closePair(); releaseURL(); ++revision; packet = preview = comparison = null; candidateReady = handedOff = false; wipeBytes(); digest = ''; error = ''; message = ''; busy = true; const token = revision; let stagingCopy = null; render();
    try {
      validateGitImportBundleLength(file?.size);
      if (typeof file.arrayBuffer !== 'function') throw Error('file');
      const buffer = await file.arrayBuffer(); if (!current() || token !== revision) return false; if (!(buffer instanceof ArrayBuffer)) throw Error('bytes'); validateGitImportBundleLength(buffer.byteLength, file.size);
      const copied = stagingCopy = buffer.slice(0), actualDigest = await hash(copied);
      if (!current() || token !== revision) return false;
      bytes = copied; stagingCopy = null; digest = actualDigest; url = urls.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})); message = 'ファイルを読み込みました。履歴の確認や保存はまだ行っていません。'; return true;
    } catch { if (current() && token === revision) { wipeBytes(); digest = ''; error = '実ファイルのサイズと読込みを確認してください。1バイト〜50MiBのGit bundleが必要です。'; } return false; }
    finally { if (stagingCopy) new Uint8Array(stagingCopy).fill(0); if (current() && token === revision) { busy = false; render(); } }
  }
  fileInput.onchange = () => stage(fileInput.files?.[0]);
  async function downloadPublic() {
    if (!current() || locked() || projectPublic !== true || repositoryVisibility !== 'public') return;
    const token = revision; busy = true; error = ''; message = '公開Git履歴を取得しています…'; render();
    try {
      if (!await confirmOrigin(token)) return;
      const buffer = await request('research_git_bundle', {projectId}); if (!current() || token !== revision) return;
      if (!(buffer instanceof ArrayBuffer)) throw Error('bytes'); validateGitImportBundleLength(buffer.byteLength);
      clearAttempt(); bytes = buffer.slice(0); const next = revision; digest = await hash(bytes); if (!current() || next !== revision) return;
      url = urls.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})); message = '公開中の全ブランチ・タグ・履歴を取得しました。コードは実行しません。';
    } catch { if (current()) error = '公開Git履歴を取得できません。公開範囲・接続先と50MiB以内のサイズを確認してください。'; }
    finally { if (current()) { busy = false; render(); } }
  }
  async function previewBundle() {
    if (!current() || locked() || !owns || !bytes || !digest) return;
    await run(async token => {
      if (!await confirmOrigin(token)) return;
      const metadata = Object.freeze(parseGitImportMetadata({requestId: (options.randomUUID ?? (() => crypto.randomUUID()))(), branch: branch.value, baseOid: base.value, headOid: head.value, bundleSha256: digest}));
      packet = metadata; preview = null; comparison = null; candidateReady = false;
      const response = await importRequest(metadata, 'preview');
      if (!current() || token !== revision || packet !== metadata) return;
      const value = parseGitImportResult(response, projectId, metadata, 'preview'); if (value.bundleBytes !== bytes.byteLength) throw Error('length'); preview = Object.freeze(value); message = '履歴情報を確認しました。まだ保存していません。差分の確認は保存後に受信Hubで別途行います。';
    });
  }
  async function saveBundle() {
    if (!current() || locked() || !owns || !bytes || !packet || !preview) return;
    await run(async token => {
      if (!await confirmOrigin(token)) return;
      const metadata = packet, plan = preview; saveSent = unknown = true; candidateReady = false; comparison = null; render();
      const response = await importRequest(metadata, 'save');
      if (!current() || token !== revision || packet !== metadata) return;
      const value = parseGitImportResult(response, projectId, metadata, 'save'); if (value.bundleBytes !== bytes.byteLength || value.baseTreeOid !== plan.baseTreeOid || value.headTreeOid !== plan.headTreeOid) throw Error('mismatch');
      unknown = false; candidateReady = true; message = '受信Hubの候補ブランチに履歴を保存しました。対象ブランチ、提案、承認は変更していません。';
    });
  }
  async function checkBundle() {
    if (!current() || busy || !saveSent || !packet || !owns) return;
    await run(async token => {
      if (!await confirmOrigin(token)) return;
      const metadata = packet, response = await request('research_git_bundle_check', {projectId, metadata}); if (!current() || token !== revision || packet !== metadata) return;
      const value = parseGitImportCheckResult(response, projectId, metadata); candidateReady = value.outcome === 'imported'; comparison = null; handedOff = false;
      message = candidateReady ? '現在の候補は変更後の版と一致します。以前の保存時のファイルハッシュや本人を証明するものではありません。' : '現在の候補を確認できません。未保存の証明ではありません。保存を再送せず、現在の状態を確認してください。';
    });
  }
  async function compare() {
    if (!current() || busy || !candidateReady || !packet) return;
    await run(async token => { if (!await confirmOrigin(token)) return; const metadata = packet, response = await request('hub_detail', {name: 'research_git_compare', ids: [projectId, metadata.headOid, metadata.baseOid]}); if (!current() || token !== revision || packet !== metadata) return; comparison = parseNativeGitDetail(response, projectId, metadata.headOid, metadata.baseOid); handedOff = false; message = '受信Hubから二版の差分を取得しました。提案の保存と承認は別操作です。'; });
  }
  async function handoff() {
    if (!current() || busy || !comparison || handedOff || !onImportedComparison) return;
    await run(async token => { if (!await confirmOrigin(token)) return; const fixed = comparison; const accepted = await onImportedComparison(fixed); if (current() && token === revision && comparison === fixed) { handedOff = accepted !== false; if (!handedOff) error = '既存の下書きや未確認の保存操作を保護するため、提案画面へ渡せませんでした。'; } });
  }
  async function p2p(sending) {
    if (!current() || busy || pair || sending && (!bytes || bytes.byteLength > P2P_LIMIT) || !sending && (!owns || locked())) return;
    let opened; const pairToken = ++pairGeneration;
    try {
      const recipientUrl = sending ? new URL(recipient(destination.value)) : null; recipientUrl?.searchParams.set('gitBundle', '1');
      const invitationUrl = recipientUrl?.href;
      const file = sending ? new File([bytes], `${projectId}.bundle`, {type: 'application/octet-stream'}) : undefined;
      pair = (options.createP2P ?? initP2PTransfer)(pairHost, {invoke, sendFile: file, invitationUrl, maxFileBytes: P2P_LIMIT, receivedFileType: 'application/octet-stream', isCurrent: () => alive() && pairToken === pairGeneration,
        onReceiveFile: sending ? undefined : async received => { if (!current() || pair !== opened || !await stage(received, true)) throw Error('この履歴を読み込めません。実ファイルのサイズと進行中の保存操作を確認してください。'); }});
      opened = pair; render(); await opened.ready;
    } catch { if (current() && pairToken === pairGeneration) { closePair(); error = '送受信画面を開けません。受信先のプロジェクトURLと接続設定を確認してください。'; render(); } }
  }
  function render() {
    if (!alive()) return;
    const children = [node(document, 'h4', 'Git履歴を渡す・受け取る'), node(document, 'p', '受信と履歴情報の確認だけでは保存しません。別Hubの本人・提案・承認は継承せず、このHubで確認します。', 'meta'), notice(`受信先Hub: ${origin || '確認中…'} · プロジェクト: ${projectId}`)];
    if (message) children.push(notice(message)); if (error) children.push(notice(error, true));
    if (!owns) children.push(notice('履歴を受け取って保存するには、リポジトリの所有者としてDesktopに接続してください。'));
    if (projectPublic === true && repositoryVisibility === 'public') children.push(button('公開Git履歴を取得', downloadPublic, locked() || !origin));
    if (owns) { fileInput.disabled = locked(); children.push(fileInput, button('端末間でGit履歴を受け取る', () => p2p(false), locked() || !!pair || !origin)); }
    if (bytes) {
      children.push(node(document, 'p', `${bytes.byteLength.toLocaleString()} バイト · 実ファイルSHA256: ${digest}`, 'meta'));
      if (url) { const link = node(document, 'a', '履歴ファイルを保存', 'head-action'); link.href = url; link.download = `${projectId}.bundle`; link.onclick = event => { if (!root.contains(link) || !current()) event.preventDefault(); }; children.push(link); }
      if (bytes.byteLength <= P2P_LIMIT) { const label = node(document, 'label', '端末間送信の受信先プロジェクトURL'); destination.disabled = busy || !!pair; label.append(destination); children.push(label, button('この履歴を端末間で渡す', () => p2p(true), busy || !!pair || !destination.value)); }
      else children.push(notice('16MiBを超える履歴は端末間転送を使えません。保存したファイルを受信Hubで選択してください（最大50MiB）。'));
      if (owns) {
        for (const [text, input] of [['対象ブランチ', branch], ['基準版の完全OID', base], ['変更後の完全OID', head]]) { input.disabled = locked(); const label = node(document, 'label', text); label.append(input); children.push(label); }
        children.push(button('受信履歴の情報を確認', previewBundle, locked() || !digest || !origin));
      }
    }
    if (preview && packet) {
      const info = node(document, 'p', `対象: ${packet.branch}\n基準版: ${packet.baseOid}\n変更後: ${packet.headOid}\n候補: ${preview.candidateBranch}\n基準tree: ${preview.baseTreeOid}\n変更後tree: ${preview.headTreeOid}\n形式: ${preview.objectFormat}`, 'meta'); info.style.whiteSpace = 'pre-wrap'; children.push(info);
      children.push(node(document, 'p', repositoryVisibility === 'public' ? '受信リポジトリは公開です。候補ブランチに追加した全履歴も公開範囲に入ります。秘密や個人情報が含まれていないことを確認してください。' : '受信リポジトリは非公開です。対象ブランチを変更せず、専用の候補ブランチだけを追加します。'));
      if (!saveSent) children.push(button('確認して候補履歴を保存', saveBundle, busy));
    }
    if (saveSent) {
      if (unknown) children.push(notice('保存結果は不明です。同じmetadataと履歴を保持しています。保存の再送は行いません。'));
      children.push(button('候補の現在状態を確認', checkBundle, busy));
      if (candidateReady) children.push(button('受信Hubで二版の差分を取得', compare, busy));
    }
    if (comparison) { const diff = node(document, 'pre', comparison.diff, 'research-git-bundle-diff'); Object.assign(diff.style, {whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: '0', maxWidth: '100%', maxHeight: '28rem', overflow: 'auto', margin: '0'}); children.push(diff); if (comparison.truncated) children.push(notice('差分の表示は途中までです。全体の確認を完了した意味ではありません。')); if (onImportedComparison) children.push(button(handedOff ? '二版の比較を提案画面へ渡しました' : 'この二版を提案画面へ', handoff, busy || handedOff)); }
    if (bytes || packet) { children.push(node(document, 'p', unknown ? '操作を終了しても、以前の履歴が未保存だったことの証明にはなりません。' : '操作を終了すると、この画面の履歴データと接続を破棄します。', 'meta')); children.push(button('この履歴の操作を終了', () => { clearAttempt(); branch.value = 'main'; base.value = head.value = destination.value = ''; error = ''; message = '画面内の履歴データを破棄しました。保存済みの候補ブランチは変更していません。'; render(); }, busy)); }
    if (pair) children.push(pairHost, button('履歴の送受信画面を閉じる', () => { closePair(); render(); }));
    root.replaceChildren(...children);
  }
  window?.addEventListener('hub-account-changed', invalidate); render();
  const ready = Promise.resolve().then(async () => { try { if (!current()) return; const value = await request('hub_origin'); if (current()) origin = hubOrigin(value); } catch { if (current()) error = '現在のHubを確認できません。接続して画面を開き直してください。'; } finally { if (current()) render(); } });
  return {root, ready, dispose, invalidate};
}
