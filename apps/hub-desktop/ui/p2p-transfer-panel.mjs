import {PeerTransfer, iceConfiguration, MAX_FILE_BYTES} from './p2p-transfer.mjs';
import {AutoPair, createPairing, readPairing, pairingLink, PAIRING_RELAY_ORIGIN} from './p2p-pairing.mjs';

const node = (document, tag, text, className = '') => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const emptyState = () => ({status: '招待を作るか、届いた招待リンクを貼り付けて接続します。', code: '', ready: false, verified: false, remoteVerified: false});
function destination(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) throw Error('招待先のURLを確認してください。');
  const url = new URL(value);
  if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('招待先はHTTPSのHubを選んでください。');
  return url;
}
function canonicalOrigin(value) {
  const url = destination(value);
  if (value !== url.origin) throw Error('現在のHubの接続先を確認できません。');
  return url.origin;
}
const validFrame = frame => Array.isArray(frame) && frame.length >= 29 && frame.length <= 90028 && Array.from(frame).every(value => Number.isInteger(value) && value >= 0 && value <= 255);

/** The caller owns the account scope. No pairing request runs before an explicit action. */
export function initP2PTransfer(target, {invoke, sendFile, invitationUrl, onReceiveFile, maxFileBytes = MAX_FILE_BYTES, receivedFileType = 'application/json', isCurrent, peerFactory, pairFactory, purpose = 'files', invitationPath = '/p2p'} = {}) {
  const ai = purpose === 'ai';
  if (!['application/json', 'application/octet-stream'].includes(receivedFileType)) throw Error('受信ファイルの形式を確認してください。');
  const document = target.ownerDocument, window = document.defaultView;
  const root = node(document, 'section', undefined, 'detail-form p2p-transfer-panel');
  root.setAttribute('aria-label', ai ? 'スマホとつなぐ' : '端末間でファイルを送受信');
  Object.assign(root.style, {minWidth: '0', overflowWrap: 'anywhere', gridTemplateColumns: 'minmax(0,1fr)'}); target.append(root);
  const urls = window?.URL?.createObjectURL ? window.URL : globalThis.URL;
  const linkInput = node(document, 'input'), fileInput = node(document, 'input'), relaySelect = node(document, 'select');
  const turnUrl = node(document, 'input'), turnUser = node(document, 'input'), turnSecret = node(document, 'input'), turnOnly = node(document, 'input');
  turnUrl.type = 'url'; turnUrl.setAttribute('aria-label', 'TURN URL'); turnUrl.spellcheck = false;
  turnUser.type = 'text'; turnUser.setAttribute('aria-label', 'TURN 利用者名'); turnUser.autocomplete = 'off';
  turnSecret.type = 'password'; turnSecret.setAttribute('aria-label', 'TURN 認証情報'); turnSecret.autocomplete = 'off';
  turnOnly.type = 'checkbox'; turnOnly.setAttribute('aria-label', 'TURN 中継のみ使う');
  linkInput.type = 'url'; linkInput.setAttribute('aria-label', '届いた招待リンク'); linkInput.autocomplete = 'off'; linkInput.spellcheck = false;
  fileInput.type = 'file'; fileInput.setAttribute('aria-label', '送信するファイル');
  relaySelect.setAttribute('aria-label', '接続サービス');
  for (const [value, label] of [['default', '既定のテスト中継'], ['hub', '現在のHubの中継']]) { const option = node(document, 'option', label); option.value = value; relaySelect.append(option); }
  for (const input of [linkInput, fileInput, relaySelect, turnUrl, turnUser, turnSecret]) Object.assign(input.style, {width: '100%', maxWidth: '100%', minWidth: '0', boxSizing: 'border-box'});
  let active = true, generation = 0, origin = '', initialized = false, busy = false, error = '', peer = null, pairing = null;
  let state = emptyState(), role = null, invitation = '', selectedFile = sendFile ?? null, preselected = !!sendFile, download = '', received = null, imported = false;
  const limitValid = Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 && maxFileBytes <= MAX_FILE_BYTES;
  const alive = () => active && isCurrent?.() !== false;
  function current() { if (alive()) return true; if (active) invalidate(); return false; }
  const notice = (text, alert = false) => { const item = node(document, 'p', text, 'meta'); item.setAttribute('role', alert ? 'alert' : 'status'); return item; };
  function revoke() { if (download) urls.revokeObjectURL(download); download = ''; received = null; imported = false; }
  function closeConnection() {
    ++generation; const previousPeer = peer, previousPair = pairing; peer = pairing = null;
    previousPair?.close(); previousPeer?.close(); clearPrivateControls(); revoke(); invitation = ''; role = null; state = emptyState(); busy = false;
  }
  function clearPrivateControls() { for (const input of root.querySelectorAll('textarea[readonly]')) input.value = ''; }
  function clearFiles(keepPrepared = false) { if (!keepPrepared) sendFile = null; selectedFile = sendFile ?? null; preselected = !!sendFile; linkInput.value = fileInput.value = turnSecret.value = turnUser.value = ''; }
  function reset() { closeConnection(); clearFiles(true); error = ''; render(); }
  function dispose() {
    if (!active) return; active = false; closeConnection(); clearFiles(); origin = ''; invitationUrl = ''; onReceiveFile = null;
    window?.removeEventListener('hub-account-changed', invalidate); root.replaceChildren();
  }
  function invalidate() { dispose(); root.replaceChildren(notice('接続が変わりました。送受信画面を開き直してください。')); }
  function button(label, action, disabled = false) {
    const element = node(document, 'button', label, 'head-action'); element.type = 'button'; element.disabled = !!disabled;
    Object.assign(element.style, {maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', justifySelf: 'start'});
    element.onclick = () => { if (!element.disabled && root.contains(element) && current()) return action(); };
    return element;
  }
  async function run(action) {
    if (!current() || busy) return;
    const token = generation; busy = true; error = ''; render();
    try { await action(); }
    catch (failure) { if (current() && token === generation) error = failure instanceof Error ? failure.message : '接続に失敗しました。'; }
    finally { if (current() && token === generation) { busy = false; render(); } }
  }
  function transport(token, relay, relayOrigin) {
    return async ({origin: requestOrigin, room, role: requestRole, expires, method, action, body, signal}) => {
      const operation = method === 'GET' && !action && body === undefined ? 'poll' : method === 'POST' && action === 'start' && body === undefined ? 'start' : method === 'POST' && action === 'signal' && body instanceof ArrayBuffer && body.byteLength >= 29 && body.byteLength <= 90028 ? 'signal' : null;
      if (!current() || token !== generation || signal?.aborted) throw Error('接続は終了しています。');
      if (!operation || requestOrigin !== relayOrigin || typeof room !== 'string' || !/^[a-f0-9]{32}$/.test(room) || !['host', 'guest'].includes(requestRole) || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 660000) throw Error('接続要求を確認できません。');
      const request = {relay, room, role: requestRole, expires, operation, ...(operation === 'signal' ? {frame: Array.from(new Uint8Array(body))} : {})};
      let cancel;
      try {
        const value = await Promise.race([Promise.resolve().then(() => { if (!current() || token !== generation || signal?.aborted) throw Error('接続は終了しています。'); return invoke('p2p_pairing_request', {request}); }), new Promise((_, reject) => { cancel = () => reject(Error('接続要求を中止しました。')); signal?.addEventListener('abort', cancel, {once: true}); if (signal?.aborted) cancel(); })]);
        if (!current() || token !== generation || signal?.aborted) throw Error('接続は終了しています。');
        if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || (value.status === 200 && operation === 'poll' ? !validFrame(value.frame) : value.frame !== null)) throw Error('接続サービスの応答を確認できません。');
        return {status: value.status, data: value.frame === null ? null : Uint8Array.from(value.frame).buffer};
      } finally { signal?.removeEventListener('abort', cancel); }
    };
  }
  function receive(next, token, connection) {
    if (!current() || token !== generation || peer !== connection) return;
    if (connection.closed) { closeConnection(); clearFiles(true); state.status = next.status; render(); return; }
    state = next;
    if (state.code) { pairing?.close(); pairing = null; invitation = ''; clearPrivateControls(); linkInput.value = ''; }
    if (state.received && state.received !== received) {
      if (!limitValid || !Number.isSafeInteger(state.received.blob?.size) || state.received.blob.size < 1 || state.received.blob.size > maxFileBytes) { closeConnection(); error = 'この画面の受信上限を超えています。'; render(); return; }
      revoke(); received = state.received;
      try { download = urls.createObjectURL(received.blob); }
      catch { error = '保存用リンクを準備できませんでした。受信した変更の取込みは別途選べます。'; }
    }
    render();
  }
  async function start(guest = false) {
    if (!initialized || !origin || !limitValid || role) return;
    if ((!peerFactory && !globalThis.RTCPeerConnection) || !globalThis.crypto?.subtle) throw Error('WebRTCに対応したDesktop環境が必要です。');
    let ticket, relay = relaySelect.value;
    const targetUrl = destination(invitationUrl || new URL(invitationPath, origin).href);
    if (guest) {
      const url = destination(linkInput.value.trim());
      if (url.origin !== origin) throw Error('招待先が現在のHubと異なります。招待されたHubへ接続してから貼り付けてください。');
      const values = url.searchParams.getAll('pairRelay');
      if (values.length > 1) throw Error('接続サービスの指定が重複しています。');
      const requested = values.length ? canonicalOrigin(values[0]) : origin;
      if (requested !== origin && requested !== PAIRING_RELAY_ORIGIN) throw Error('この招待の中継は利用できません。既定の中継か、受信先Hubの中継で招待を作り直してください。');
      relay = requested === PAIRING_RELAY_ORIGIN ? 'default' : 'hub'; ticket = readPairing(url.hash);
    } else {
      if (targetUrl.searchParams.getAll('pairRelay').length > 1) throw Error('接続サービスの指定が重複しています。');
      if (!['default', 'hub'].includes(relay)) throw Error('接続サービスを選んでください。');
      ticket = createPairing();
    }
    const relayOrigin = relay === 'default' ? PAIRING_RELAY_ORIGIN : origin, token = generation;
    let connection, pair;
    try {
      const configuration = iceConfiguration(undefined, turnUrl.value.trim(), turnUser.value, turnSecret.value, turnOnly.checked);
      connection = peerFactory ? peerFactory(configuration, next => receive(next, token, connection)) : new PeerTransfer(configuration, next => receive(next, token, connection));
      peer = connection; role = guest ? 'guest' : 'host'; relaySelect.value = relay;
      const onError = message => { if (current() && token === generation && peer === connection) { closeConnection(); clearFiles(true); error = message; render(); } };
      pair = pairFactory ? pairFactory(connection, ticket, relayOrigin, role, onError, transport(token, relay, relayOrigin)) : new AutoPair(connection, ticket, relayOrigin, role, onError, transport(token, relay, relayOrigin)); pairing = pair;
      await pair.connect();
      if (!current() || token !== generation || peer !== connection) { pair.close(); connection.close(); return; }
      linkInput.value = '';
      if (!guest && !state.code) { targetUrl.searchParams.set('pairRelay', relayOrigin); targetUrl.hash = new URL(pairingLink(relayOrigin, ticket)).hash; invitation = targetUrl.href; state = {...state, status: '招待リンクを相手へ渡し、相手の画面で接続を承認してください。'}; }
      else if (!state.code) state = {...state, status: '相手の端末につないでいます…'};
    } catch (failure) { if (token === generation) { peer = pairing = null; pair?.close(); connection?.close(); clearPrivateControls(); clearFiles(true); role = null; invitation = ''; state = emptyState(); } throw failure; }
  }
  const canTransfer = () => state.ready === true && state.verified === true && state.remoteVerified === true;
  const validFile = file => file && typeof file.arrayBuffer === 'function' && Number.isSafeInteger(file.size) && file.size >= 1 && file.size <= maxFileBytes;
  function render() {
    if (!alive()) return;
    clearPrivateControls();
    const children = [node(document, 'h4', ai ? 'スマホとつなぐ' : '端末間でファイルを送受信'), notice(state.status)];
    if (error) children.push(notice(error, true));
    if (!limitValid) children.push(notice('ファイル上限は1バイト〜16MiBで設定してください。', true));
    children.push(node(document, 'p', ai ? '依頼と返答は端末間だけで送り、サーバーへ保存しません。接続開始時にGoogleのSTUNを使い、接続相手へIPアドレスが伝わる場合があります。招待リンクはスマホで開き、両方の画面の確認番号が同じことを確かめてください。' : 'ファイルは端末間で送り、サーバーへ保存しません。接続開始時にGoogleのSTUNを使い、接続相手へIPアドレスが伝わる場合があります。', 'meta'));
    if (!role) {
      relaySelect.disabled = busy || !initialized; linkInput.disabled = busy || !initialized;
      const relayLabel = node(document, 'label', '接続サービス'); relayLabel.append(relaySelect); children.push(relayLabel);
      children.push(node(document, 'p', `現在のHub: ${origin || '確認中…'} · テスト中継は接続元が制限されています。つながらない場合は両方のHubが許可された中継で招待を作り直してください。`, 'meta'));
      const settings = node(document, 'details', undefined, 'detail-form'); settings.append(node(document, 'summary', '直接つながらない場合のTURN設定'), node(document, 'p', '利用可能なTURN中継を両端末に設定して、新しい招待で接続します。認証情報はこの画面のメモリだけに保持します。', 'meta'));
      for (const [labelText, input] of [['TURN URL', turnUrl], ['TURN 利用者名', turnUser], ['TURN 認証情報', turnSecret], ['TURN 中継のみ使う', turnOnly]]) { input.disabled = busy; const label = node(document, 'label', labelText); label.append(input); settings.append(label); }
      children.push(settings);
      children.push(button('接続の招待を作る', () => run(() => start()), busy || !initialized || !origin || !limitValid));
      const inviteLabel = node(document, 'label', '届いた招待リンク'); inviteLabel.append(linkInput); children.push(inviteLabel, button('この招待の端末に接続', () => run(() => start(true)), busy || !initialized || !origin || !limitValid || !linkInput.value.trim()));
    }
    if (invitation) {
      const text = node(document, 'textarea'); text.value = invitation; text.readOnly = true; text.rows = 3; text.setAttribute('aria-label', '送る招待リンク');
      children.push(text, node(document, 'p', '10分間有効。招待には秘密の接続鍵を含みます。相手にだけ渡し、この画面を開いたままにしてください。', 'meta'));
      children.push(button('招待リンクをコピー', () => run(async () => { if (!window?.navigator?.clipboard?.writeText) throw Error('招待リンク欄を選択してコピーしてください。'); await window.navigator.clipboard.writeText(invitation); }), busy));
    }
    if (state.code) {
      const code = node(document, 'output', state.code); code.setAttribute('aria-label', '接続の確認番号'); children.push(code);
      children.push(node(document, 'p', '両方の画面の番号を通話などで照合し、それぞれ確認してください。'));
      children.push(button(state.verified ? 'この端末は確認済み' : '同じ番号であることを確認した', () => run(() => peer?.verify()), busy || state.verified));
      if (!state.remoteVerified) children.push(notice('相手の番号確認を待っています。'));
    }
    if (ai && canTransfer()) children.push(notice('スマホとつながっています。「スマホから使える」をオンにした接続だけが、スマホの一覧に出ます。接続を終えると、実行中の依頼も止まります。'));
    if (!ai && canTransfer()) {
      children.push(node(document, 'p', `${maxFileBytes.toLocaleString()} バイトまで。画面を閉じると接続と未保存の受信データは失われます。`, 'meta'));
      if (preselected) children.push(node(document, 'p', `送信するファイル: ${selectedFile?.name ?? ''}`));
      else { fileInput.disabled = busy; const label = node(document, 'label', '送信するファイル'); label.append(fileInput); children.push(label); if (selectedFile) children.push(node(document, 'p', `${selectedFile.name} · ${selectedFile.size.toLocaleString()} バイト`)); }
      if (selectedFile && !validFile(selectedFile)) children.push(notice('ファイルのサイズと読込みを確認してください。この画面の上限を超えるファイルは送れません。', true));
      children.push(button(preselected ? 'この変更を送信申請' : 'このファイルを送信申請', () => run(() => { if (!canTransfer() || !validFile(selectedFile)) throw Error('接続とファイルのサイズを確認してください。'); return peer.offer(selectedFile); }), busy || !limitValid || !validFile(selectedFile)));
    }
    if (!ai && state.pending) {
      const pending = state.pending, valid = limitValid && Number.isSafeInteger(pending.size) && pending.size >= 1 && pending.size <= maxFileBytes;
      children.push(node(document, 'p', `${pending.name} · ${pending.size.toLocaleString()} バイトを受信しますか？ 自動では保存・実行しません。`));
      if (!valid) children.push(notice('この画面の受信上限を超えています。', true));
      const actions = node(document, 'div', undefined, 'detail-form-row');
      actions.append(button('受信する', () => run(() => { if (!canTransfer() || state.pending !== pending || !valid) throw Error('受信内容を確認してください。'); peer.accept(); }), busy || !canTransfer() || !valid), button('断る', () => run(() => peer?.reject()), busy)); children.push(actions);
    }
    if (!ai && received) {
      if (download) { const link = node(document, 'a', `受信ファイルを保存: ${received.name}`, 'head-action'); link.href = download; link.download = received.name; link.onclick = event => { if (!root.contains(link) || !current()) event.preventDefault(); }; children.push(link); }
      if (onReceiveFile) children.push(button(imported ? '受信内容の確認画面へ渡しました' : '受信した変更の内容を確認', () => run(async () => { const token = generation, item = received; if (!item || imported || !limitValid || item.blob.size > maxFileBytes) return; const FileType = globalThis.File ?? window.File; await onReceiveFile(new FileType([item.blob], item.name, {type: receivedFileType})); if (current() && token === generation && item === received) imported = true; }), busy || imported || !limitValid));
    }
    if (role) children.push(button('接続を終了してやり直す', reset));
    root.replaceChildren(...children);
  }
  linkInput.oninput = () => { if (current() && !busy && !role) { error = ''; render(); } };
  fileInput.onchange = () => { if (current() && !busy && canTransfer()) { selectedFile = fileInput.files?.[0] ?? null; error = ''; render(); } };
  window?.addEventListener('hub-account-changed', invalidate); render();
  const initial = generation;
  const ready = Promise.resolve().then(async () => {
    try { if (!current() || initial !== generation) return; const value = await invoke('hub_origin'); if (current() && initial === generation) { const configured = destination(value); if (value.length > 2048 || configured.search || configured.hash) throw Error('Hub URL invalid'); origin = configured.origin; initialized = true; } }
    catch { if (current() && initial === generation) { error = '現在のHubの接続先を確認できません。Hubへ接続して画面を開き直してください。'; initialized = true; } }
    finally { if (current() && initial === generation) render(); }
  });
  return {root, ready, dispose, invalidate};
}
