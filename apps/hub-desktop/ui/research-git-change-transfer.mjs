import {createResearchGitChangePackage, readResearchGitChangeFile, parseResearchGitChangeTarget} from './research-git-change-package.mjs';
import {initP2PTransfer} from './p2p-transfer-panel.mjs';
import {parseNativeGitDetail} from './research-git-browser.mjs';

const node = (document, tag, text, className = '') => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const fileName = 'research-git-change.json';
const guidance = 'このファイルはGitの中身を運びません。受信Hubで両版を公開ブランチ・タグから読めるよう、Git bundleを復元して別の候補ブランチへpushしてください。反映先のブランチは基準版のまま保ちます。パッチから作ったコミットは元のIDと異なることがあります。その場合は新たな二版で提案してください。';

function viewScope(target, options, signedIn) {
  const document = target.ownerDocument, window = document.defaultView;
  const root = node(document, 'section', undefined, 'detail-form');
  root.style.minWidth = '0'; root.style.overflowWrap = 'anywhere'; target.append(root);
  let active = true;
  const releases = new Set();
  const notice = text => { const element = node(document, 'p', text, 'meta'); element.setAttribute('role', 'status'); return element; };
  const alive = () => active && signedIn() && options.isCurrent?.() !== false;
  function dispose() {
    if (!active) return;
    active = false;
    for (const release of releases) release();
    releases.clear();
    window?.removeEventListener('hub-account-changed', invalidate);
    root.replaceChildren();
  }
  function invalidate() { dispose(); root.replaceChildren(notice('接続が変わりました。受け渡し画面を開き直してください。')); }
  function current() { if (alive()) return true; if (active) invalidate(); return false; }
  const button = (label, run) => {
    const element = node(document, 'button', label, 'head-action'); element.type = 'button';
    element.style.maxWidth = '100%'; element.style.whiteSpace = 'normal'; element.style.overflowWrap = 'anywhere';
    element.onclick = () => { if (!element.disabled && root.contains(element) && current()) return run(); };
    return element;
  };
  window?.addEventListener('hub-account-changed', invalidate);
  return {document, window, root, notice, button, current, alive, releases, dispose, invalidate};
}

function preview(document, packet) {
  const result = node(document, 'section', undefined, 'detail-form'); result.setAttribute('aria-label', '変更ファイルの確認');
  result.append(node(document, 'p', `宛先Hub: ${packet.target.origin}`), node(document, 'p', `宛先プロジェクト: ${packet.target.projectId}`),
    node(document, 'p', `基準版: ${packet.baseOid}`), node(document, 'p', `変更後: ${packet.headOid}`),
    node(document, 'h4', packet.title || '題なし'), node(document, 'p', packet.summary || '理由なし'),
    node(document, 'p', '題・理由と二版のIDをファイルに含めます。私的な提案理由も受け取った人が読めます。'),
    node(document, 'p', '内容ハッシュは同一性の照合用です。送付者・出自・承認権限を証明しません。', 'meta'),
    node(document, 'p', `内容ハッシュ: ${packet.contentHash}`, 'meta'));
  return result;
}

/** Prepares a metadata file only after an immutable preview and explicit confirmation. */
export function researchGitChangeExport(target, {comparison, title = '', summary = ''}, options = {}) {
  const scope = viewScope(target, options, () => options.signedIn !== false);
  const {document, window, root, notice, button, current, releases} = scope;
  let version = 0, packet = null, url = null, preparedFile = null, pairView = null, busy = false, error = '';
  const pairHost = node(document, 'div');
  function closePair() { pairView?.dispose(); pairView = null; pairHost.replaceChildren(); }
  let pair;
  try {
    pair = parseNativeGitDetail(comparison, comparison.projectId, comparison.commit.oid, comparison.baseOid);
    if (!pair.baseOid || pair.baseOid === pair.commit.oid) throw Error('invalid_pair');
  } catch { pair = undefined; error = '持ち出す二版の比較を確認できません。比較を読み直してください。'; }
  const destination = node(document, 'input'), subject = node(document, 'input'), reason = node(document, 'textarea');
  destination.type = 'url'; destination.setAttribute('aria-label', '受信先プロジェクトのURL');
  subject.type = 'text'; subject.value = title; subject.maxLength = 240; subject.setAttribute('aria-label', '持ち出す提案の題');
  reason.value = summary; reason.maxLength = 500; reason.rows = 3; reason.setAttribute('aria-label', '持ち出す変更の理由');
  const urls = window?.URL?.createObjectURL ? window.URL : globalThis.URL;
  const createURL = options.createObjectURL ?? (blob => urls.createObjectURL(blob));
  const revokeURL = options.revokeObjectURL ?? (value => urls.revokeObjectURL(value));
  function releaseURL() { preparedFile = null; closePair(); if (url !== null) { const old = url; url = null; revokeURL(old); } }
  releases.add(() => { ++version; packet = null; destination.value = subject.value = reason.value = ''; releaseURL(); });
  function edited() { if (!current()) return; ++version; packet = null; busy = false; error = ''; releaseURL(); render(); }
  for (const input of [destination, subject, reason]) {
    input.style.minWidth = '0'; input.style.maxWidth = '100%'; input.style.width = '100%'; input.style.boxSizing = 'border-box'; input.oninput = edited;
  }
  async function check() {
    if (!current() || busy || !pair) return;
    const token = ++version; busy = true; packet = null; error = ''; releaseURL(); render();
    try {
      const value = await createResearchGitChangePackage({protocol: 'hub.research-git-change.v1', target: parseResearchGitChangeTarget(destination.value), baseOid: pair.baseOid, headOid: pair.commit.oid, title: subject.value, summary: reason.value});
      if (current() && token === version) packet = Object.freeze({...value, target: Object.freeze({...value.target})});
    } catch { if (current() && token === version) error = '宛先URL・題・理由とファイルの上限を確認してください。'; }
    finally { if (current() && token === version) { busy = false; render(); } }
  }
  function prepareFile() {
    if (!current() || busy || !packet || url !== null) return;
    try {
      preparedFile = new globalThis.File([JSON.stringify(packet)], fileName, {type: 'application/json'});
      url = createURL(new (window?.Blob ?? globalThis.Blob)([JSON.stringify(packet)], {type: 'application/json'}));
    }
    catch { error = 'ファイルを準備できませんでした。もう一度確認してください。'; }
    render();
  }
  async function openP2P() {
    if (!current() || busy || url === null || !preparedFile || !options.invoke || pairView) return;
    const token = version; let opening = null; busy = true; error = ''; render();
    try {
      pairView = (options.createP2P ?? initP2PTransfer)(pairHost, {invoke: options.invoke, sendFile: preparedFile,
        invitationUrl: new URL(`/v2/research/${packet.target.projectId}`, packet.target.origin).href,
        maxFileBytes: 8192, isCurrent: () => scope.alive() && token === version});
      opening = pairView; await opening.ready;
    } catch { if (current() && token === version && pairView === opening) { closePair(); error = '送受信画面を開けませんでした。接続設定を確認してやり直してください。'; } }
    finally { if (current() && token === version) { busy = false; render(); } }
  }
  function render() {
    if (!scope.alive()) return;
    destination.disabled = subject.disabled = reason.disabled = busy;
    const children = [node(document, 'h4', '別のHubへ変更を渡す'), node(document, 'p', '受信先の完全なプロジェクトURLを指定し、内容を確認して保存します。', 'meta')];
    const form = node(document, 'div', undefined, 'detail-form');
    for (const [label, input] of [['受信先プロジェクトのURL', destination], ['提案の題', subject], ['変更の理由', reason]]) { const field = node(document, 'label', label); field.append(input); form.append(field); }
    const checkButton = button('持ち出す内容を確認', check); checkButton.disabled = busy || !pair; form.append(checkButton); children.push(form);
    if (packet) {
      children.push(preview(document, packet));
      if (url === null) children.push(button('確認してファイルを準備', prepareFile));
      else {
        const download = node(document, 'a', '変更ファイルを保存', 'head-action'); download.href = url; download.download = fileName;
        download.onclick = event => { if (!root.contains(download) || !current()) event.preventDefault(); };
        children.push(download, notice('送信する操作と相手の受信承諾は、送受信画面で別途確認します。'));
        if (options.invoke) { const handoff = button('このファイルを端末間で渡す', openP2P); handoff.disabled = busy || !!pairView; children.push(handoff); }
        if (pairView) children.push(pairHost, button('送受信画面を閉じる', () => { closePair(); render(); }));
      }
    }
    if (busy) children.push(notice('内容を確認中…'));
    if (error) children.push(notice(error));
    children.push(node(document, 'p', guidance, 'meta')); root.replaceChildren(...children);
  }
  if (options.signedIn === false) root.append(notice('持ち出すにはHubへ接続してログインしてください。'));
  else render();
  return {root, ready: Promise.resolve(), dispose: scope.dispose, invalidate: scope.invalidate};
}

/** File selection only stages metadata. Import uses this Hub's public comparison and account-bound invoke. */
export function researchGitChangeImport(target, context, options = {}) {
  const {projectId} = context;
  const scope = viewScope(target, options, () => context.signedIn !== false);
  const {document, root, notice, button, current, releases} = scope;
  let version = 0, packet = null, busy = false, error = '', imported = false, pairView = null;
  const pairHost = node(document, 'div');
  function closePair() { pairView?.dispose(); pairView = null; pairHost.replaceChildren(); }
  releases.add(closePair);
  async function receiveP2P() {
    if (!current() || busy || !options.invoke || pairView) return;
    let opening = null;
    try {
      pairView = (options.createP2P ?? initP2PTransfer)(pairHost, {invoke: options.invoke, maxFileBytes: 8192,
        isCurrent: scope.alive, onReceiveFile: async file => { if (current() && pairView === opening && !await stage(file)) throw Error('変更ファイルの形式・ハッシュ・8KiB以内のサイズを確認してください。'); }});
      opening = pairView; render(); await opening.ready;
    } catch { if (current() && pairView === opening) { closePair(); error = '送受信画面を開けませんでした。'; render(); } }
  }
  const input = node(document, 'input'); input.type = 'file'; input.accept = '.json,application/json'; input.setAttribute('aria-label', '受信した変更ファイル');
  input.style.minWidth = '0'; input.style.maxWidth = '100%';
  releases.add(() => { ++version; packet = null; input.value = ''; });
  async function stage(receivedFile) {
    if (!current()) return;
    const token = ++version, file = receivedFile ?? input.files?.[0]; packet = null; busy = false; error = ''; imported = false; render();
    if (!file) return;
    busy = true; render();
    try { const value = await readResearchGitChangeFile(file); if (current() && token === version) packet = Object.freeze({...value, target: Object.freeze({...value.target})}); }
    catch { if (current() && token === version) error = '変更ファイルの形式・ハッシュ・8KiB以内のサイズを確認してください。'; }
    finally { if (current() && token === version) { busy = false; render(); } }
    return current() && token === version && packet !== null;
  }
  input.onchange = () => stage();
  async function importDraft() {
    if (!current() || busy || !packet || imported || !options.onImport) return;
    const token = version, value = packet; busy = true; error = ''; render();
    try {
      if (value.target.projectId !== projectId) throw Error('target_mismatch');
      const origin = await options.invoke('hub_origin');
      if (!current() || token !== version || packet !== value) return;
      if (typeof origin !== 'string' || origin !== value.target.origin) throw Error('target_mismatch');
      const raw = await options.invoke('hub_detail', {name: 'research_git_compare', ids: [projectId, value.headOid, value.baseOid]});
      if (!current() || token !== version || packet !== value) return;
      const comparison = parseNativeGitDetail(raw, projectId, value.headOid, value.baseOid);
      if (!current() || token !== version || packet !== value) return;
      const accepted = await options.onImport({comparison, title: value.title, summary: value.summary});
      if (current() && token === version && packet === value) {
        imported = accepted !== false;
        if (!imported) error = '既存の下書きや保存中の操作を保護するため、取り込めませんでした。';
      }
    } catch (cause) {
      if (current() && token === version && packet === value) error = cause?.message === 'target_mismatch' ? 'ファイルの宛先Hub・プロジェクトが現在の画面と一致しません。' : '受信Hubで二版の公開比較を確認できないため、取り込みを中止しました。';
    } finally { if (current() && token === version) { busy = false; render(); } }
  }
  function render() {
    if (!scope.alive()) return;
    input.disabled = busy;
    const children = [node(document, 'h4', '受け取った変更ファイル'), node(document, 'p', 'ファイルを読むだけでは下書きやGitを変更しません。', 'meta'), input];
    if (options.invoke) { const receive = button('端末間で変更ファイルを受け取る', receiveP2P); receive.disabled = busy || !!pairView; children.push(receive); }
    if (pairView) children.push(pairHost, button('送受信画面を閉じる', () => { closePair(); render(); }));
    if (packet) {
      children.push(preview(document, packet));
      const confirm = button('提案フォームへ取り込む', importDraft); confirm.disabled = busy || imported || !options.onImport; children.push(confirm);
    }
    if (busy) children.push(notice('受信内容を確認中…'));
    if (imported) children.push(notice('提案フォームへ取り込みました。内容を確認してから、そのHubで提案を保存してください。'));
    if (error) children.push(notice(error));
    children.push(node(document, 'p', guidance, 'meta')); root.replaceChildren(...children);
  }
  if (context.signedIn === false) { input.disabled = true; root.append(input, notice('取り込むにはHubへ接続してログインしてください。')); }
  else render();
  return {root, ready: Promise.resolve(), dispose: scope.dispose, invalidate: scope.invalidate};
}
