const id = value => typeof value === 'string' && value.length <= 128 && !/\p{Cc}/u.test(value) && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const publicTrack = value => typeof value === 'string' && value.length === 42 && !/\p{Cc}/u.test(value) && /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const shape = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
function wire(value) {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || json.length > 2097152 || new TextEncoder().encode(json).length > 2097152) throw Error('response_limit');
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string') throw Error('invalid_text');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (required && !normalized || normalized.length > max || /\p{Cc}/u.test(normalized) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(normalized)) throw Error('invalid_text');
  return normalized;
}
function playlist(value, kind) {
  const key = kind === 'video' ? 'videoIds' : 'workIds';
  if (!shape(value, ['id', 'title', 'description', key, 'createdAt', 'updatedAt']) || !id(value.id) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !Array.isArray(value[key]) || kind === 'music' && value[key].length > 200) throw Error('invalid_playlist');
  const items = Array.from(value[key], value => { if (!id(value) && !(kind === 'music' && publicTrack(value))) throw Error('invalid_item'); return value; });
  if (new Set(items).size !== items.length) throw Error('duplicate_item');
  return { id: value.id, title: text(value.title, 80, true), description: text(value.description, 500), items, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function snapshot(value, kind, viewer) {
  wire(value);
  if (!shape(value, ['viewerId', 'playlists']) || !id(value.viewerId) || viewer && value.viewerId !== viewer || !Array.isArray(value.playlists) || value.playlists.length > 100) throw Error('invalid_list');
  const playlists = Array.from(value.playlists, item => playlist(item, kind));
  if (new Set(playlists.map(item => item.id)).size !== playlists.length) throw Error('duplicate_playlist');
  return { viewerId: value.viewerId, playlists };
}

function playlistScope(value) {
  if (value === null) return null;
  if (!shape(value, ['key', 'generation']) || typeof value.key !== 'string' || value.key.length > 4096 || !Number.isSafeInteger(value.generation) || value.generation < 0) throw Error('invalid_scope');
  const parts = JSON.parse(value.key);
  if (!Array.isArray(parts) || parts.length !== 2 || JSON.stringify(parts) !== value.key || typeof parts[0] !== 'string' || parts[0].length > 512 || !id(parts[1])) throw Error('invalid_scope');
  const origin = new URL(parts[0]);
  if (origin.origin !== parts[0] || origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol)) throw Error('invalid_scope');
  return { key: JSON.stringify(parts), generation: value.generation };
}
const sameScope = (left, right) => left && right && left.key === right.key && left.generation === right.generation;
function playlistMemory(value, kind, account, scope) {
  if (!shape(value, ['version', 'kind', 'account', 'scope', 'viewerId', 'selectedId', 'limit', 'create', 'drafts', 'intent', 'message']) || value.version !== 1 || value.kind !== kind || value.account !== account || !sameScope(playlistScope(value.scope), scope)) throw Error('invalid_memory');
  wire(value);
  if (value.viewerId !== null && !id(value.viewerId) || value.selectedId !== null && !id(value.selectedId) || !Number.isSafeInteger(value.limit) || value.limit < 50 || value.limit > 2097152 || value.limit % 50 || !Array.isArray(value.drafts) || value.drafts.length > 100 || typeof value.message !== 'string' || value.message.length > 1000) throw Error('invalid_memory');
  const rawText = (value, maximum) => typeof value === 'string' && value.length <= maximum;
  if (!shape(value.create, ['title', 'description', 'open']) || !rawText(value.create.title, 4096) || !rawText(value.create.description, 4096) || typeof value.create.open !== 'boolean') throw Error('invalid_memory');
  const itemIds = values => Array.isArray(values) && (kind !== 'music' || values.length <= 200) && values.every(value => id(value) || kind === 'music' && publicTrack(value)) && new Set(values).size === values.length;
  const seen = new Set();
  for (const pair of value.drafts) {
    if (!Array.isArray(pair) || pair.length !== 2 || !id(pair[0]) || seen.has(pair[0])) throw Error('invalid_memory');
    seen.add(pair[0]); const draft = pair[1];
    if (!shape(draft, ['title', 'description', 'baseTitle', 'baseDescription', 'items', 'baseItems']) || !rawText(draft.title, 4096) || !rawText(draft.description, 4096) || text(draft.baseTitle, 80, true) !== draft.baseTitle || text(draft.baseDescription, 500) !== draft.baseDescription || !itemIds(draft.items) || !itemIds(draft.baseItems)) throw Error('invalid_memory');
  }
  const goal = value.intent;
  if (goal !== null) {
    if (!goal || !['create', 'update', 'add', 'remove', 'order', 'delete'].includes(goal.type) || goal.type === 'order' && kind !== 'music') throw Error('invalid_memory');
    const keys = goal.type === 'create' ? ['type', 'values', 'createdId'] : goal.type === 'delete' ? ['type', 'target'] : ['type', 'target', 'values', ...(['add', 'remove'].includes(goal.type) ? ['itemId'] : [])];
    if (!shape(goal, keys) || goal.type !== 'create' && !id(goal.target)) throw Error('invalid_memory');
    if (goal.type === 'create' && goal.createdId !== null && !id(goal.createdId)) throw Error('invalid_memory');
    if (['create', 'update'].includes(goal.type)) {
      if (!shape(goal.values, ['title', 'description']) || text(goal.values.title, 80, true) !== goal.values.title || text(goal.values.description, 500) !== goal.values.description) throw Error('invalid_memory');
    } else if (goal.type !== 'delete') {
      if (['add', 'remove'].includes(goal.type) && !id(goal.itemId) && !(kind === 'music' && publicTrack(goal.itemId))) throw Error('invalid_memory');
      if (kind === 'video' ? !shape(goal.values, ['videoId']) || goal.values.videoId !== goal.itemId : !shape(goal.values, ['workIds']) || !itemIds(goal.values.workIds)) throw Error('invalid_memory');
    }
  }
  return structuredClone(value);
}

export function createMediaPlaylists({ document, kind, invoke, getAccount = () => null, getScope, state = {}, isCurrent = () => true, onOpen = () => {}, onPlay, selectedItem, resolveItem, renderCover }) {
  const element = document.createElement('section'); element.className = 'media-playlists card detail-form'; element.setAttribute('aria-label', kind === 'video' ? '動画プレイリスト' : '音楽プレイリスト');
  const node = (tag, className, value) => { const item = document.createElement(tag); item.className = className; if (value !== undefined) item.textContent = value; return item; };
  const button = (label, action, data = {}) => { const item = node('button', 'head-action', label); item.type = 'button'; Object.assign(item.dataset, { action, ...data }); return item; };
  const field = (label, name, value = '', multiline = false) => {
    const wrapper = node('label', 'field'), input = node(multiline ? 'textarea' : 'input', ''); input.name = name; input.value = value; input.maxLength = multiline ? 500 : 80; input.setAttribute('aria-label', label); if (!multiline) input.type = 'text'; else input.rows = 3;
    wrapper.append(node('span', '', label), input); return { wrapper, input };
  };
  const title = node('h3', '', kind === 'video' ? '動画プレイリスト' : '音楽プレイリスト');
  const status = node('p', 'meta', '一覧を読み込みます…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const update = button('一覧を更新', 'reload'), heading = node('div', 'actions'); heading.append(title, update);
  const createForm = node('form', 'detail-form'), createTitle = field('新しいプレイリスト名', 'create-title'), createDescription = field('新しいプレイリストの説明', 'create-description', '', true);
  const createButton = button('プレイリストを作成', 'create'); createForm.dataset.form = 'create'; createForm.append(node('h4', '', '新しいプレイリスト'), createTitle.wrapper, createDescription.wrapper, createButton);
  const createPanel = node('details', 'detail-form'); createPanel.append(node('summary', '', '新しいプレイリストを作成'), createForm);
  const recovery = node('div', 'detail-form'), content = node('div', 'detail-form'); element.append(heading, node('p', 'meta', 'このHubプロフィールのプレイリストを整理します。一覧は最大100件です。'), status, createPanel, recovery, content);
  const account = () => { const value = getAccount(); return typeof value === 'string' && value.length > 0 ? value : null; };
  const accountKey = account(); let disposed = false, invalidated = false, busy = false, loaded = false, data = null, selectedId = null, limit = 50, intent = null, uncertain = false, recovered = false, deleteId = null, playGeneration = 0;
  const drafts = new Map();
  let scope = null, restoredViewer = null, restoredMessage = '';
  let selected = null;
  try { if (selectedItem !== undefined && selectedItem !== null) { if ((!id(selectedItem.id) && !(kind === 'music' && publicTrack(selectedItem.id))) || typeof selectedItem.title !== 'string' || selectedItem.title.length > 500) throw Error('invalid_selected'); selected = { id: selectedItem.id, title: selectedItem.title }; } } catch { status.textContent = '選択中のコンテンツを確認できません。追加操作は利用できません。'; }
  function invalidate() {
    if (disposed || invalidated) return; delete state.checkpoint; playGeneration++; invalidated = true; busy = false; loaded = false; data = null; intent = null; drafts.clear(); selectedId = null; deleteId = null; content.replaceChildren(); recovery.replaceChildren(); createTitle.input.value = ''; createDescription.input.value = ''; status.textContent = 'アカウントが変わりました。接続先を確認して、この画面を開き直してください。'; paint();
  }
  const live = () => {
    if (!disposed && !invalidated && account() !== accountKey) invalidate();
    return !disposed && !invalidated && accountKey !== null && element.isConnected && !element.closest('[hidden]') && isCurrent();
  };
  const writable = () => live() && loaded && !busy && !uncertain;
  function capture() {
    if (disposed || invalidated || !scope || account() !== accountKey) return null;
    const value = { version: 1, kind, account: accountKey, scope: { ...scope }, viewerId: data?.viewerId ?? restoredViewer, selectedId, limit,
      create: { title: createTitle.input.value, description: createDescription.input.value, open: createPanel.open }, drafts: [...drafts], intent, message: busy && !intent ? state.checkpoint?.message ?? '' : status.textContent };
    try { return playlistMemory(value, kind, accountKey, scope); } catch { return null; }
  }
  function remember() { const value = capture(); if (value) state.checkpoint = value; }
  async function freshScope() {
    if (typeof getScope !== 'function') return live();
    const next = playlistScope(await getScope());
    if (!live()) return false;
    if (!next || scope && !sameScope(next, scope)) { invalidate(); return false; }
    if (!scope) { scope = next; restore(); } return true;
  }
  function restore() {
    if (!state.checkpoint) return;
    let value; try { value = playlistMemory(state.checkpoint, kind, accountKey, scope); } catch { delete state.checkpoint; return; }
    restoredViewer = value.viewerId; selectedId = value.selectedId; limit = value.limit;
    createTitle.input.value = value.create.title; createDescription.input.value = value.create.description; createPanel.open = value.create.open;
    for (const [key, draft] of value.drafts) drafts.set(key, draft);
    intent = value.intent; uncertain = intent !== null; recovered = false; status.textContent = restoredMessage = value.message;
  }
  const active = () => data?.playlists.find(item => item.id === selectedId);
  const orderChanged = (item, draft) => !same(draft.items, draft.baseItems);
  function merge(next) {
    for (const item of next.playlists) {
      const draft = drafts.get(item.id);
      if (!draft) drafts.set(item.id, { title: item.title, description: item.description, baseTitle: item.title, baseDescription: item.description, items: [...item.items], baseItems: [...item.items] });
      else {
        if (draft.title === draft.baseTitle) draft.title = item.title;
        if (draft.description === draft.baseDescription) draft.description = item.description;
        if (same(draft.items, draft.baseItems)) { draft.items = [...item.items]; draft.baseItems = [...item.items]; }
        draft.baseTitle = item.title; draft.baseDescription = item.description;
      }
    }
    for (const key of drafts.keys()) if (!next.playlists.some(item => item.id === key)) drafts.delete(key);
    data = next; if (!active()) selectedId = next.playlists[0]?.id ?? null;
  }
  function paint() {
    remember();
    const locked = disposed || invalidated || !accountKey || !loaded || busy || uncertain;
    element.setAttribute('aria-busy', String(busy)); update.disabled = disposed || invalidated || !accountKey || busy;
    createTitle.input.disabled = createDescription.input.disabled = busy || disposed || invalidated || !accountKey;
    createButton.disabled = locked;
    for (const control of content.querySelectorAll('button,input,textarea,select')) control.disabled = locked || control.dataset.blocked === 'true';
    for (const control of recovery.querySelectorAll('button')) control.disabled = busy || disposed || invalidated || !recovered;
  }
  function renderRecovery() {
    recovery.replaceChildren();
    if (!uncertain || intent?.type !== 'create' || !recovered) return;
    const matches = data.playlists.filter(item => item.title === intent.values.title && item.description === intent.values.description);
    recovery.append(node('p', 'meta', matches.length ? '同じ内容のリストが見つかりました。今回の作成が成功したとは断定できません。内容を確認して使うリストを選んでください。' : '一覧を再取得しましたが、作成結果は確認できません。新しく作成すると重複する可能性があります。'));
    if (matches.length) for (const item of matches) recovery.append(button(`「${item.title}」を使う`, 'use-existing', { playlistId: item.id }));
    else recovery.append(button('一覧を確認して新しい作成へ戻る', 'new-create'));
  }
  function render() {
    content.replaceChildren(); renderRecovery();
    if (!data) { paint(); return; }
    if (!data.playlists.length) { content.append(node('p', 'meta', 'プレイリストはまだありません。名前を入力して作成できます。')); paint(); return; }
    const choose = node('label', 'field'), select = node('select', ''); select.name = 'playlist'; select.setAttribute('aria-label', '使うプレイリスト');
    for (const item of data.playlists) { const option = node('option', '', item.title); option.value = item.id; select.append(option); } select.value = selectedId;
    choose.append(node('span', '', '使うプレイリスト'), select); content.append(choose);
    const item = active(), draft = drafts.get(item.id), editor = node('form', 'detail-form'); editor.dataset.form = 'edit'; editor.dataset.playlistId = item.id;
    const name = field('プレイリスト名', 'edit-title', draft.title), description = field('プレイリストの説明', 'edit-description', draft.description, true);
    const actions = node('div', 'actions'); actions.append(button('名前・説明を保存', 'update', { playlistId: item.id }), button('プレイリストを削除…', 'delete-preview', { playlistId: item.id })); editor.append(name.wrapper, description.wrapper, actions); const editPanel=node('details','detail-form'); editPanel.append(node('summary','','名前・説明を編集'),editor); content.append(editPanel);
    if (deleteId === item.id) {
      const confirmation = node('div', 'detail-form'); confirmation.append(node('p', 'meta', `「${item.title}」を削除します。プレイリストだけを削除し、動画・音源自体は削除しません。`), button('このプレイリストを削除する', 'delete-confirm', { playlistId: item.id }), button('削除をやめる', 'delete-cancel')); content.append(confirmation);
    }
    const changed = kind === 'music' && orderChanged(item, draft), conflict = changed && !same(draft.baseItems, item.items);
    if (kind === 'music' && typeof onPlay === 'function') {
      const playable = item.items.filter(publicTrack), start = button('先頭から再生', 'play-first', { playlistId: item.id });
      start.dataset.blocked = String(changed || !playable.length); content.append(start,
        node('p', 'meta', `Hub公開曲 ${playable.length}曲を保存順で再生します。外部作品 ${item.items.length - playable.length}件は再生対象から除きます。`));
    }
    if (selected) {
      const add = button(`${kind === 'video' ? 'この動画' : 'この作品'}を追加: ${selected.title || selected.id}`, 'add', { playlistId: item.id }); add.dataset.blocked = String(changed || item.items.includes(selected.id) || kind === 'music' && item.items.length >= 200);
      content.append(add); if (item.items.includes(selected.id)) content.append(node('p', 'meta', '選択中のコンテンツは追加済みです。')); else if (kind === 'music' && item.items.length >= 200) content.append(node('p', 'meta', '音楽は1つのプレイリストにつき200項目までです。'));
    }
    if (kind === 'music') {
      const orderActions = node('div', 'actions'), save = button('曲の順序を保存', 'save-order', { playlistId: item.id }), cancel = button('順序変更を取り消す', 'cancel-order', { playlistId: item.id }); save.dataset.blocked = String(!changed || conflict); cancel.dataset.blocked = String(!changed); orderActions.append(save, cancel); content.append(orderActions);
      if (changed) content.append(node('p', 'meta', conflict ? '別の変更で曲一覧が変わっています。順序変更を取り消してから、最新の曲一覧を並べ替えてください。' : '曲の順序はまだ保存していません。「曲の順序を保存」で確定します。追加・除去は保存後にできます。'));
    }
    const items = kind === 'music' ? draft.items : item.items, list = node('ol', 'result-grid'); list.setAttribute('aria-label', 'プレイリストの項目');
    for (const [index, itemId] of items.slice(0, limit).entries()) {
      const row = node('li', 'card'), itemTitle = selected?.id === itemId ? selected.title : ''; const itemName = node('strong', '', itemTitle || `${kind === 'video' ? '動画' : '作品'} ${index + 1}`), itemMeta = node('p', 'meta', typeof resolveItem === 'function' ? '' : itemId); row.append(itemName, itemMeta);
      if (typeof resolveItem === 'function') hydrateItem(row, itemId, itemName, itemMeta);
      const rowActions = node('div', 'actions'); rowActions.append(button(kind === 'video' ? '動画を開く' : '作品を開く', 'open', { itemId }));
      if (kind === 'music' && typeof onPlay === 'function' && publicTrack(itemId)) {
        const play = button('この曲から再生', 'play-item', { playlistId: item.id, itemId }); play.dataset.blocked = String(changed); rowActions.append(play);
      }
      const remove = button('この項目を除去', 'remove', { playlistId: item.id, itemId }); remove.dataset.blocked = String(changed); rowActions.append(remove);
      if (kind === 'music') { const up = button('上へ', 'up', { playlistId: item.id, itemId }), down = button('下へ', 'down', { playlistId: item.id, itemId }); up.dataset.blocked = String(index === 0 || conflict); down.dataset.blocked = String(index === items.length - 1 || conflict); rowActions.append(up, down); }
      row.append(rowActions); list.append(row);
    }
    content.append(node('p', 'meta', `${items.length}項目`), list);
    if (!items.length) content.append(node('p', 'meta', '項目はまだありません。動画・作品の詳細からこのリストへ追加できます。'));
    if (limit < items.length) content.append(button('続きを表示', 'more'));
    paint();
  }
  function hydrateItem(row, itemId, itemName, itemMeta) {
    row.classList.add('media-item-row'); row.dataset.itemId = itemId;
    const apply = (entry) => {
      if (disposed || !row.isConnected) return;
      if (!entry) { itemMeta.textContent = '作品情報を取得できません（非公開・削除の可能性）'; return; }
      itemName.textContent = entry.title;
      itemMeta.textContent = (kind === 'video' ? [entry.channel, entry.provider] : [entry.artist, entry.album]).filter(Boolean).join(' · ');
      if (typeof renderCover === 'function' && !row.querySelector('.media-item-cover')) { try { const cover = renderCover(entry); if (cover) { const slot = node('span', 'media-item-cover'); slot.dataset.kind = kind; slot.append(cover); row.prepend(slot); } } catch {} }
    };
    Promise.resolve(resolveItem(itemId)).then(apply, () => apply(null));
  }
  function desired(goal, next) {
    const item = next.playlists.find(item => item.id === goal.target);
    if (goal.type === 'create') return goal.createdId && next.playlists.some(item => item.id === goal.createdId && item.title === goal.values.title && item.description === goal.values.description && item.items.length === 0);
    if (goal.type === 'delete') return !item;
    if (!item) return false;
    if (goal.type === 'update') return item.title === goal.values.title && item.description === goal.values.description;
    if (goal.type === 'add') return item.items.includes(goal.itemId);
    if (goal.type === 'remove') return !item.items.includes(goal.itemId);
    return same(item.items, goal.values.workIds);
  }
  function accept(result, goal) {
    wire(result);
    if (result?.viewerId !== data.viewerId) throw Error('invalid_viewer');
    if (goal.type === 'create') {
      if (!shape(result, ['viewerId', 'playlist'])) throw Error('invalid_create');
      const created = playlist(result.playlist, kind); if (data.playlists.some(item => item.id === created.id) || created.title !== goal.values.title || created.description !== goal.values.description || created.items.length) throw Error('invalid_create'); goal.createdId = created.id; return;
    }
    const flag = goal.type === 'delete' ? 'deleted' : goal.type === 'add' && kind === 'video' ? 'added' : goal.type === 'remove' && kind === 'video' ? 'removed' : 'updated';
    const keys = ['viewerId', 'playlistId', flag]; if (['add', 'remove'].includes(goal.type) && kind === 'video') keys.push('videoId');
    if (!shape(result, keys) || result.playlistId !== goal.target || (flag === 'removed' ? typeof result[flag] !== 'boolean' : result[flag] !== true) || keys.includes('videoId') && result.videoId !== goal.itemId) throw Error('invalid_write');
  }
  function confirmed(goal) {
    if (goal.type === 'create') { selectedId = goal.createdId; createTitle.input.value = ''; createDescription.input.value = ''; createPanel.open = false; }
    const draft = drafts.get(goal.target), item = data.playlists.find(item => item.id === goal.target);
    if (draft && item) {
      if (goal.type === 'update') { draft.title = item.title; draft.description = item.description; }
      if (['add', 'remove', 'order'].includes(goal.type)) { draft.items = [...item.items]; draft.baseItems = [...item.items]; }
    }
    intent = null; uncertain = false; recovered = false; deleteId = null; limit = 50;
  }
  async function read(manual = true) {
    if (!live() || busy) return;
    busy = true; status.textContent = '一覧を確認しています…'; paint();
    try {
      if (typeof getScope === 'function' && !await freshScope()) return;
      const raw = await invoke('hub_client', { name: `${kind}_playlists` }); if (!live() || typeof getScope === 'function' && !await freshScope()) return;
      const viewer = data?.viewerId ?? restoredViewer;
      if (typeof getScope === 'function' && viewer && raw?.viewerId !== viewer) { invalidate(); return; }
      const next = snapshot(raw, kind, viewer); merge(next); loaded = true;
      if (intent && desired(intent, data)) { confirmed(intent); status.textContent = '現在の一覧が希望した状態と一致しています。'; }
      else if (intent?.type === 'create') { uncertain = true; recovered = manual; status.textContent = '作成結果が不明です。自動で再送せず、一覧を確認してください。'; }
      else if (intent && manual) { intent = null; uncertain = false; status.textContent = '最新の一覧を取得しました。希望した保存結果とは一致していません。入力・項目を確認して操作してください。'; }
      else status.textContent = intent ? '保存結果が不明です。「一覧を更新」で状態を確認してください。' : manual ? '' : restoredMessage;
      restoredMessage = '';
      render();
    } catch { if (live()) { loaded = false; status.textContent = '一覧を取得・確認できませんでした。入力と表示中の一覧は保持しています。「一覧を更新」で再取得してください。'; } }
    finally { busy = false; if (live()) paint(); }
  }
  async function write(goal) {
    if (!writable()) return;
    intent = goal; recovered = false; busy = true; status.textContent = '保存して一覧を確認しています…'; paint();
    const operation = goal.type === 'order' || kind === 'music' && ['add', 'remove'].includes(goal.type) ? 'set_music_playlist_items' : `${goal.type}_${kind}_playlist${['add', 'remove'].includes(goal.type) ? '_item' : ''}`;
    const args = { action: operation, options: goal.values ?? {} }; if (goal.target) args.target = goal.target;
    try {
      if (typeof getScope === 'function' && !await freshScope()) return;
      const result = await invoke('hub_client_action', args); if (!live() || typeof getScope === 'function' && !await freshScope()) return; accept(result, goal); remember();
      const raw = await invoke('hub_client', { name: `${kind}_playlists` }); if (!live() || typeof getScope === 'function' && !await freshScope()) return;
      const next = snapshot(raw, kind, data.viewerId); merge(next); loaded = true;
      if (!desired(goal, data)) throw Error('unconfirmed_state');
      confirmed(goal); status.textContent = goal.type === 'create' ? '作成を確認しました。' : goal.type === 'delete' ? '削除を確認しました。' : '保存を確認しました。'; render();
    } catch (error) { if (live()) {
      const message = typeof error === 'string' ? error : error?.message;
      if (typeof message === 'string' && /^playlist_rejected:(400|403|404|409|413|429):プレイリストを保存できませんでした。$/.test(message)) { intent = null; uncertain = false; status.textContent = '保存が拒否されました。入力と権限を確認してください。最新の状態は「一覧を更新」で確認できます。'; }
      else { uncertain = true; status.textContent = '保存結果を確認できませんでした。入力は保持しています。重ねて送信せず、「一覧を更新」で状態を確認してください。'; }
      render();
    } }
    finally { busy = false; if (live()) paint(); }
  }
  function metadata(form) { return { title: text(form.querySelector('input').value, 80, true), description: text(form.querySelector('textarea').value, 500) }; }
  function editAction(type) {
    if (!writable()) return;
    try { const target = active(); if (type === 'create') void write({ type, values: metadata(createForm), createdId: null }); else if (target) void write({ type, target: target.id, values: metadata(content.querySelector('form')) }); }
    catch { status.textContent = '名前は1〜80文字、説明は500文字以内で入力してください。入力内容は保持しています。'; }
  }
  async function play(startId) {
    if (!writable() || kind !== 'music' || typeof onPlay !== 'function') return;
    const item = active(), draft = item && drafts.get(item.id);
    if (!item || orderChanged(item, draft)) return;
    const savedItems = [...item.items], workIds = savedItems.filter(publicTrack);
    if (!workIds.length || startId !== undefined && (!publicTrack(startId) || !workIds.includes(startId))) return;
    const playlistId = item.id, viewer = data.viewerId, turn = ++playGeneration;
    const current = () => playGeneration === turn && busy && live() && data?.viewerId === viewer && selectedId === playlistId
      && element.querySelector('[name="playlist"]')?.value === playlistId && !!active() && same(active().items, savedItems);
    busy = true; status.textContent = '保存順の公開曲の再生を準備しています…'; paint();
    try {
      const result = await onPlay({ workIds: [...workIds], startId: startId ?? workIds[0], playlistId }, { isCurrent: current });
      if (current()) status.textContent = result === false ? '再生開始を確認できませんでした。もう一度操作してください。' : '保存順の公開曲の再生を要求しました。';
    } catch { if (current()) status.textContent = '再生を開始できませんでした。プレイリストと入力は保持しています。'; }
    finally { if (playGeneration === turn) { playGeneration++; busy = false; if (live()) paint(); } }
  }
  const click = event => {
    const control = event.target.closest?.('button[data-action]'); if (!control || !element.contains(control) || !live() || control.disabled) return;
    const action = control.dataset.action;
    if (action === 'reload') { void read(); return; }
    if (busy) return;
    if (action === 'use-existing' && uncertain && recovered && intent?.type === 'create') { const item = data.playlists.find(item => item.id === control.dataset.playlistId); if (item?.title !== intent.values.title || item.description !== intent.values.description) return; selectedId = item.id; intent = null; uncertain = false; recovered = false; createTitle.input.value = ''; createDescription.input.value = ''; status.textContent = '既存のリストを選びました。今回の作成の成否は確認できていません。'; render(); return; }
    if (action === 'new-create' && uncertain && recovered && intent?.type === 'create' && !data.playlists.some(item => item.title === intent.values.title && item.description === intent.values.description)) { intent = null; uncertain = false; recovered = false; status.textContent = '新しい作成操作に戻りました。内容を確認して「プレイリストを作成」を押してください。'; render(); return; }
    if (!writable()) return;
    if (action === 'create' || action === 'update') { editAction(action); return; }
    const item = active(), draft = item && drafts.get(item.id); if (!item) return;
    if (control.dataset.playlistId && control.dataset.playlistId !== item.id) return;
    if (action === 'play-first') void play();
    else if (action === 'play-item') void play(control.dataset.itemId);
    else if (action === 'delete-preview') { deleteId = item.id; render(); }
    else if (action === 'delete-cancel') { deleteId = null; render(); }
    else if (action === 'delete-confirm' && deleteId === item.id) void write({ type: 'delete', target: item.id });
    else if (action === 'more') { limit += 50; render(); }
    else if (action === 'open' && draft.items.includes(control.dataset.itemId)) { try { Promise.resolve(onOpen({ id: control.dataset.itemId, title: selected?.id === control.dataset.itemId ? selected.title : '' }, kind)).catch(() => { if (live()) status.textContent = 'この項目を開けませんでした。'; }); } catch { status.textContent = 'この項目を開けませんでした。'; } }
    else if (action === 'cancel-order' && kind === 'music') { draft.items = [...item.items]; draft.baseItems = [...item.items]; render(); }
    else if (['up', 'down'].includes(action) && kind === 'music' && same(draft.baseItems, item.items)) { const index = draft.items.indexOf(control.dataset.itemId), next = index + (action === 'up' ? -1 : 1); if (index >= 0 && next >= 0 && next < draft.items.length) { [draft.items[index], draft.items[next]] = [draft.items[next], draft.items[index]]; render(); } }
    else if (action === 'save-order' && kind === 'music' && orderChanged(item, draft) && same(draft.baseItems, item.items)) void write({ type: 'order', target: item.id, values: { workIds: [...draft.items] } });
    else if (action === 'add' && selected && !item.items.includes(selected.id) && !(kind === 'music' && (orderChanged(item, draft) || item.items.length >= 200))) void write({ type: 'add', target: item.id, itemId: selected.id, values: kind === 'video' ? { videoId: selected.id } : { workIds: [...item.items, selected.id] } });
    else if (action === 'remove' && item.items.includes(control.dataset.itemId) && !(kind === 'music' && orderChanged(item, draft))) void write({ type: 'remove', target: item.id, itemId: control.dataset.itemId, values: kind === 'video' ? { videoId: control.dataset.itemId } : { workIds: item.items.filter(id => id !== control.dataset.itemId) } });
  };
  const change = event => { if (!live() || busy || !element.contains(event.target)) return; if (event.target.name === 'playlist' && data?.playlists.some(item => item.id === event.target.value) && !uncertain) { playGeneration++; selectedId = event.target.value; deleteId = null; limit = 50; render(); } };
  const input = event => { if (!live() || busy || !element.contains(event.target)) return; const draft = drafts.get(selectedId); if (draft && event.target.name === 'edit-title') draft.title = event.target.value; if (draft && event.target.name === 'edit-description') draft.description = event.target.value; remember(); };
  const toggle = event => { if (event.target === createPanel && live()) remember(); };
  const submit = event => { if (!element.contains(event.target)) return; event.preventDefault(); if (event.target.dataset.form === 'create') editAction('create'); else if (event.target.dataset.form === 'edit') editAction('update'); };
  element.addEventListener('click', click); element.addEventListener('change', change); element.addEventListener('input', input); element.addEventListener('submit', submit); element.addEventListener('toggle', toggle, true); document.defaultView?.addEventListener('hub-account-changed', invalidate); document.defaultView?.addEventListener('hub-origin-changed', invalidate);
  if (!['video', 'music'].includes(kind)) { invalidated = true; status.textContent = 'プレイリストの種類を確認できませんでした。'; } else if (!accountKey) status.textContent = 'Hubに接続すると自分のプレイリストを利用できます。';
  paint(); const ready = Promise.resolve().then(async () => { try { if (await freshScope()) await read(false); } catch { if (live()) { loaded = false; status.textContent = '接続先を確認できません。「一覧を更新」で再取得してください。'; paint(); } } });
  return { element, ready, capture, invalidate, destroy() { if (disposed) return; remember(); playGeneration++; disposed = true; data = null; intent = null; drafts.clear(); element.removeEventListener('click', click); element.removeEventListener('change', change); element.removeEventListener('input', input); element.removeEventListener('submit', submit); element.removeEventListener('toggle', toggle, true); document.defaultView?.removeEventListener('hub-account-changed', invalidate); document.defaultView?.removeEventListener('hub-origin-changed', invalidate); element.replaceChildren(); element.remove(); } };
}
