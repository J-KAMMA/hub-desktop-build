const keys = ['mentions', 'replies', 'guideUpdates', 'governance', 'membership'];
const labels = { mentions: '自分へのメンション', replies: '自分への返信', guideUpdates: 'ガイドの更新', governance: 'ガバナンスの更新', membership: '参加・会員状態の更新' };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
const shape = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const date = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) && Number.isFinite(Date.parse(value));
function wire(value) {
  const json = JSON.stringify(value); if (typeof json !== 'string' || json.length > 1048576 || new TextEncoder().encode(json).length > 1048576) throw Error('response_limit');
}
function preferences(value) {
  if (!shape(value, keys) || keys.some(key => typeof value[key] !== 'boolean')) throw Error('invalid_preferences');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function page(value, communityId) {
  wire(value);
  if (!shape(value, ['viewerId', 'communityId', 'preferences']) || !id(value.viewerId) || value.communityId !== communityId) throw Error('invalid_page');
  return { viewerId: value.viewerId, communityId, preferences: preferences(value.preferences) };
}

export function createCommunityNotifications({ document, communityId, invoke, getAccount = () => null, isCurrent = () => true, onReadAll = () => {}, canReadAll = false }) {
  const element = document.createElement('section'); element.className = 'community-notifications'; element.setAttribute('aria-label', 'コミュニティの通知・既読');
  const node = (tag, className, value) => { const item = document.createElement(tag); item.className = className; if (value !== undefined) item.textContent = value; return item; };
  const button = (label, action) => { const item = node('button', 'head-action', label); item.type = 'button'; item.dataset.action = action; return item; };
  const details = node('details', 'detail-form'); details.append(node('summary', '', 'このコミュニティの通知設定'));
  const form = node('form', 'detail-form'), fields = node('div', 'detail-form'), save = button('通知設定を保存', 'save'), recheck = button('設定を再確認', 'recheck'), resume = button('再確認した設定をもとに編集へ戻る', 'resume'), cancel = button('未保存の変更を取り消す', 'cancel');
  const note = node('p', 'meta', '通知設定を読み込みます…'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  const actions = node('div', 'actions'); actions.append(save, cancel, recheck, resume); form.append(fields, actions, note); details.append(form);
  const readActions = node('div', 'actions'), read = button('すべて既読にする', 'read-all'), newRead = button('確認して新しい一括既読操作へ戻る', 'new-read'); readActions.append(read, newRead);
  const readNote = node('p', 'meta', 'このコミュニティの投稿をすべて既読にします。操作後に新しく届く投稿は対象外です。'); readNote.setAttribute('role', 'status'); readNote.setAttribute('aria-live', 'polite');
  element.append(details, readActions, readNote);
  const account = () => { const value = getAccount(); return typeof value === 'string' && value ? value : null; };
  const accountKey = account(); let disposed = false, invalidated = !id(communityId), busy = false, loaded = false, viewerId = null, data = null, draft = null, desired = null, uncertain = false, checked = false, readUncertain = false, readChecked = false;
  function invalidate(message = 'アカウントが変わりました。この画面を開き直してください。') {
    if (disposed || invalidated) return; invalidated = true; data = draft = desired = null; loaded = busy = false; viewerId = null; fields.replaceChildren(); note.textContent = message; readNote.textContent = ''; paint();
  }
  const live = () => {
    if (!disposed && !invalidated && account() !== accountKey) invalidate();
    return !disposed && !invalidated && accountKey !== null && element.isConnected && !element.closest('[hidden]') && isCurrent();
  };
  function owner(next) { if (viewerId !== null && next !== viewerId) { invalidate('本人の一致を確認できません。この画面を開き直してください。'); throw Error('viewer_changed'); } viewerId = next; }
  function dirty() {
    if (!data || !draft) return false;
    return keys.some(key => draft.preferences[key] !== data.preferences[key]);
  }
  function paint() {
    element.setAttribute('aria-busy', String(busy)); const denied = disposed || invalidated || accountKey === null;
    save.disabled = denied || busy || !loaded || uncertain; recheck.disabled = denied || busy;
    for (const control of fields.querySelectorAll('input,select')) control.disabled = denied || busy || !loaded || uncertain;
    resume.hidden = !uncertain || !checked; resume.disabled = denied || busy || !loaded;
    const changed = dirty(); cancel.disabled = denied || busy || !loaded || uncertain || !changed;
    read.disabled = denied || busy || canReadAll !== true || uncertain || readUncertain;
    newRead.hidden = !readUncertain || !readChecked; newRead.disabled = denied || busy || canReadAll !== true;
    readActions.hidden = canReadAll !== true;
  }
  function render() {
    fields.replaceChildren();
    if (!data || !draft) { paint(); return; }
    for (const key of keys) {
      const label = node('label', 'field'), input = node('input', ''); input.type = 'checkbox'; input.name = key; input.checked = draft.preferences[key]; input.setAttribute('aria-label', labels[key]); label.append(input, node('span', '', labels[key]));
      if (draft.preferences[key] !== data.preferences[key]) label.append(node('small', 'meta', `再取得した設定: ${data.preferences[key] ? '通知する' : '通知しない'}`)); fields.append(label);
    }
    paint();
  }
  function merge(next) {
    if (!draft) draft = { preferences: { ...next.preferences } };
    else for (const key of keys) if (draft.preferences[key] === data.preferences[key]) draft.preferences[key] = next.preferences[key];
    data = next;
  }
  const matches = (wanted, next) => keys.every(key => wanted[key] === next.preferences[key]);
  function confirmed() { draft = { preferences: { ...data.preferences } }; desired = null; uncertain = false; checked = false; }
  async function load(manual = true) {
    if (!live() || busy) return;
    busy = true; note.textContent = '通知設定を確認しています…'; paint();
    try {
      const raw = await invoke('hub_detail', { name: 'community_notifications', ids: [communityId] }); if (!live()) return;
      const next = page(raw, communityId); owner(next.viewerId); merge(next); loaded = true;
      if (desired && matches(desired, data)) { confirmed(); note.textContent = '再取得した設定が希望した内容と一致しています。'; }
      else if (desired) { uncertain = true; checked = manual; note.textContent = '設定を再取得しましたが、希望した保存結果とは一致していません。草稿を確認して編集へ戻ってください。'; }
      else note.textContent = '';
      render();
    } catch { if (live()) { loaded = false; note.textContent = '通知設定を取得・確認できませんでした。草稿は保持しています。「設定を再確認」で再取得してください。'; } }
    finally { busy = false; if (live()) { if (manual && readUncertain) { readChecked = true; readNote.textContent = '通知設定の再確認だけでは、一括既読の成否は確認できません。次に実行すると新しい一括既読操作になり、その時点の投稿も対象になります。'; } paint(); } }
  }
  function rejected(error, kind) {
    const message = typeof error === 'string' ? error : error?.message;
    const prefix = kind === 'save' ? 'community_preferences_rejected' : 'community_read_all_rejected', ending = kind === 'save' ? '通知設定を保存できませんでした。' : '既読状態を更新できませんでした。';
    return typeof message === 'string' && ['400', '403', '404', '409', '413', '429'].includes(message.split(':')[1]) && message === `${prefix}:${message.split(':')[1]}:${ending}`;
  }
  async function saveSettings() {
    if (!live() || busy || !loaded || uncertain || !draft) return;
    let wanted;
    try {
      wanted = page({ viewerId, communityId, preferences: draft.preferences }, communityId).preferences;
    } catch { note.textContent = '通知設定の入力を確認してください。草稿は保持しています。'; return; }
    desired = wanted; checked = false; busy = true; note.textContent = '保存して通知設定を確認しています…'; paint();
    try {
      const receipt = await invoke('hub_client_action', { action: 'update_community_notifications', target: communityId, options: wanted }); if (!live()) return;
      wire(receipt); if (!shape(receipt, ['viewerId', 'communityId', 'preferences']) || !id(receipt.viewerId) || receipt.communityId !== communityId) throw Error('invalid_save'); owner(receipt.viewerId);
      const saved = preferences(receipt.preferences); if (!keys.every(key => saved[key] === wanted[key])) throw Error('unconfirmed_preferences');
      const raw = await invoke('hub_detail', { name: 'community_notifications', ids: [communityId] }); if (!live()) return;
      const next = page(raw, communityId); owner(next.viewerId); merge(next); loaded = true;
      if (!matches(wanted, data)) throw Error('unconfirmed_save');
      confirmed(); note.textContent = '通知設定の保存を確認しました。'; render();
    } catch (error) { if (live()) {
      if (rejected(error, 'save')) { desired = null; uncertain = false; note.textContent = '通知設定の保存が拒否されました。入力と参加資格を確認してください。草稿は保持しています。'; }
      else { uncertain = true; note.textContent = '通知設定の保存結果が不明です。草稿は保持しています。重ねて送信せず「設定を再確認」で保存状態を確認してください。'; }
      render();
    } }
    finally { busy = false; if (live()) paint(); }
  }
  async function readAll() {
    if (!live() || busy || uncertain || readUncertain || canReadAll !== true) return;
    busy = true; readNote.textContent = '既読状態を更新しています…'; paint();
    try {
      const raw = await invoke('hub_client_action', { action: 'read_all_community_channels', target: communityId, options: {} }); if (!live()) return;
      wire(raw); if (!shape(raw, ['viewerId', 'communityId', 'read', 'updatedAt']) || !id(raw.viewerId) || raw.communityId !== communityId || raw.read !== true || !date(raw.updatedAt)) throw Error('invalid_read');
      owner(raw.viewerId); const receipt = { viewerId: raw.viewerId, communityId, read: true, updatedAt: raw.updatedAt };
      readNote.textContent = '投稿を既読にしました。新しく届く投稿は対象外です。';
      try { await onReadAll(receipt); } catch { if (live()) readNote.textContent = '既読操作は完了しましたが、表示を更新できませんでした。コミュニティを開き直してください。'; }
    } catch (error) { if (live()) {
      if (rejected(error, 'read')) readNote.textContent = '既読状態の更新が拒否されました。参加資格と接続状態を確認してください。';
      else { readUncertain = true; readChecked = false; readNote.textContent = '一括既読の結果が不明です。同じ操作を自動再送しません。先に「設定を再確認」で表示を確認してください。'; }
    } }
    finally { busy = false; if (live()) paint(); }
  }
  const click = event => {
    const control = event.target.closest?.('button[data-action]'); if (!control || !element.contains(control) || control.disabled || !live()) return;
    if (control.dataset.action === 'recheck') void load();
    else if (control.dataset.action === 'save') void saveSettings();
    else if (control.dataset.action === 'read-all') void readAll();
    else if (control.dataset.action === 'resume' && !busy && loaded && uncertain && checked) { desired = null; uncertain = false; checked = false; note.textContent = '再取得した設定をもとに編集へ戻りました。草稿を確認して保存してください。'; render(); }
    else if (control.dataset.action === 'cancel' && !busy && loaded && !uncertain) { confirmed(); note.textContent = '未保存の変更を取り消しました。再取得した設定を表示しています。'; render(); }
    else if (control.dataset.action === 'new-read' && !busy && readUncertain && readChecked && canReadAll === true) { readUncertain = false; readChecked = false; readNote.textContent = '新しい一括既読操作に戻りました。実行する場合は「すべて既読にする」を押してください。'; paint(); }
  };
  const change = event => {
    if (!live() || busy || !loaded || uncertain || !draft || !fields.contains(event.target)) return;
    if (keys.includes(event.target.name) && event.target.type === 'checkbox') draft.preferences[event.target.name] = event.target.checked;
    paint();
  };
  const submit = event => { if (element.contains(event.target)) { event.preventDefault(); void saveSettings(); } };
  const accountChanged = () => invalidate();
  element.addEventListener('click', click); element.addEventListener('change', change); element.addEventListener('submit', submit); document.defaultView?.addEventListener('hub-account-changed', accountChanged);
  if (invalidated) note.textContent = 'コミュニティの指定を確認できませんでした。'; else if (accountKey === null) note.textContent = 'Hubに接続すると自分の通知設定を利用できます。'; paint();
  const ready = Promise.resolve().then(() => load(false));
  return { element, ready, destroy() { if (disposed) return; disposed = true; busy = false; element.setAttribute('aria-busy', 'false'); data = draft = desired = null; viewerId = null; element.removeEventListener('click', click); element.removeEventListener('change', change); element.removeEventListener('submit', submit); document.defaultView?.removeEventListener('hub-account-changed', accountChanged); element.replaceChildren(); element.remove(); } };
}
