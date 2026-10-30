import { faviconSlot } from './browser-favicon.mjs';
const MAX_IMPORT_BYTES = 1048576;

export function renderBrowserLibrary({ document, window, host, items, button, invoke, refresh, report, open, bindOpen }) {
  const root = document.createElement('section'); root.setAttribute('aria-label', 'お気に入りの管理'); host.append(root);
  let entries = [...items], folder = null, query = '', editing = null, busy = false, stale = false, preview = null, fileTurn = 0, loadTurn = 0;
  const live = () => root.isConnected && host.contains(root) && !root.closest('[hidden]');
  const line = text => { const node = document.createElement('p'); node.className = 'browser-menu-empty'; node.textContent = text; return node; };
  const status = line(''); status.setAttribute('role', 'status');
  const controls = document.createElement('div'); controls.className = 'browser-tools';
  const search = document.createElement('input'); search.type = 'search'; search.className = 'browser-menu-filter'; search.placeholder = 'タイトル・URLで絞り込む'; search.setAttribute('aria-label', 'お気に入りを絞り込む');
  const folders = document.createElement('select'); folders.className = 'browser-menu-filter'; folders.setAttribute('aria-label', 'お気に入りのフォルダー');
  const list = document.createElement('div'), transfer = document.createElement('div'); transfer.className = 'browser-tools';
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; file.setAttribute('aria-label', 'お気に入りのJSONファイル');
  const previewHost = document.createElement('div');
  root.append(controls, status, list, transfer, previewHost); controls.append(search, folders);
  function control(label, action, className = 'browser-menu-tab') {
    const node = button(label, async () => { if (!live() || !root.contains(node) || busy || stale || node.disabled) return; await action(); }, className);
    node.disabled = busy || stale; return node;
  }
  function failure(error, message) { status.textContent = message; report(error); }
  async function reload() {
    const turn = ++loadTurn;
    try {
      const value = await invoke('browser_favorites');
      if (turn !== loadTurn || !live()) return;
      if (!Array.isArray(value)) throw Error('invalid_favorites');
      entries = value; stale = false; renderFolders(); render();
    } catch (error) {
      if (turn !== loadTurn || !live()) return;
      stale = true; failure(error, 'お気に入りの最新の状態を確認できませんでした。再取得してください。'); render();
    }
  }
  async function mutate(command, args, success) {
    if (!live() || busy || stale) return;
    busy = true; status.textContent = '保存結果を確認しています…'; render();
    let done = false;
    try { await invoke(command, args); done = true; editing = null; if (command === 'browser_import_favorites') preview = null; }
    catch (error) { failure(error, 'お気に入りを保存できませんでした。内容を確認して再度操作してください。'); }
    try { await refresh(); await reload(); if (done && live() && !stale) status.textContent = success; }
    catch (error) { stale = true; failure(error, '保存後の状態を確認できませんでした。再取得してください。'); }
    finally { busy = false; if (live()) { render(); renderPreview(); } }
  }
  function renderFolders() {
    const values = [...new Set(entries.map(item => item.folder || ''))].sort();
    if (folder !== null && !values.includes(folder)) folder = null;
    folders.replaceChildren();
    for (const [value, label] of [['', 'すべてのフォルダー'], ...values.map(value => [JSON.stringify(value), value || '未分類'])]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; folders.append(option);
    }
    folders.value = folder === null ? '' : JSON.stringify(folder);
  }
  function editForm(entry) {
    const form = document.createElement('form'); form.className = 'browser-tools'; form.setAttribute('aria-label', `${entry.title || entry.url}を編集`);
    const title = document.createElement('input'); title.type = 'text'; title.className = 'browser-menu-filter'; title.value = editing.title; title.setAttribute('aria-label', 'お気に入りのタイトル');
    const folderInput = document.createElement('input'); folderInput.type = 'text'; folderInput.className = 'browser-menu-filter'; folderInput.value = editing.folder; folderInput.setAttribute('aria-label', 'フォルダー名');
    title.oninput = () => { editing.title = title.value; }; folderInput.oninput = () => { editing.folder = folderInput.value; };
    title.disabled = folderInput.disabled = busy || stale;
    const save = control('保存', () => {
      if (!validText(title.value, 300) || !validText(folderInput.value, 80)) { status.textContent = 'タイトルは300文字、フォルダー名は80文字以内で入力してください。制御文字は使えません。'; return; }
      editing = {url:entry.url, title:title.value, folder:folderInput.value};
      return mutate('browser_update_favorite', { url: entry.url, title: title.value, folder: folderInput.value }, 'お気に入りを更新しました。');
    });
    form.onsubmit = event => { event.preventDefault(); save.click(); };
    form.append(title, folderInput, save, control('キャンセル', () => { editing = null; render(); })); return form;
  }
  function render() {
    root.setAttribute('aria-busy', String(busy)); list.replaceChildren();
    search.disabled = folders.disabled = file.disabled = busy;
    exportButton.disabled = importButton.disabled = busy || stale;
    const visible = entries.map((entry, position) => ({ entry, position })).filter(({entry}) => (folder === null || (entry.folder || '') === folder) && `${entry.title || ''} ${entry.url}`.toLocaleLowerCase().includes(query));
    if (!visible.length) list.append(line(entries.length ? '一致するページはありません。' : 'お気に入りはまだありません。'));
    for (const {entry, position} of visible) {
      const row = document.createElement('div'); row.className = 'browser-menu-row'; row.dataset.url = entry.url;
      const launch = control('', () => open(entry.url), 'browser-menu-open');
      bindOpen?.(launch, entry.url, () => live() && root.contains(launch) && !busy && !stale);
      launch.append(faviconSlot(document, { icon: entry.icon, url: entry.url }));
      const text = document.createElement('span'); text.className = 'browser-menu-text';
      const title = document.createElement('strong'); title.className = 'browser-menu-title'; title.textContent = entry.title || entry.url;
      const detail = document.createElement('small'); detail.className = 'browser-menu-sub'; detail.textContent = `${entry.folder || '未分類'} · ${entry.url}`; text.append(title, detail); launch.append(text); row.append(launch);
      const up = control('↑', () => mutate('browser_move_favorite', {url: entry.url, position: position - 1}, 'お気に入りの順番を更新しました。'));
      const down = control('↓', () => mutate('browser_move_favorite', {url: entry.url, position: position + 1}, 'お気に入りの順番を更新しました。'));
      up.setAttribute('aria-label', `${entry.title || entry.url}を上へ移動`); down.setAttribute('aria-label', `${entry.title || entry.url}を下へ移動`);
      up.disabled ||= position === 0; down.disabled ||= position === entries.length - 1;
      row.append(up, down, control('編集', () => { editing = {url:entry.url, title:entry.title || '', folder:entry.folder || ''}; render(); }), control('削除', () => mutate('browser_remove_favorite', {url: entry.url}, 'お気に入りを削除しました。')));
      if (editing?.url === entry.url) row.append(editForm(entry)); list.append(row);
    }
    renderPreview();
    if (stale) {
      const retry = button('再取得', async () => { if (!live() || busy) return; busy = true; render(); await reload(); busy = false; if (live()) { if (!stale) status.textContent = 'お気に入りを再取得しました。'; render(); } }); list.append(retry);
    }
  }
  function renderPreview() {
    previewHost.replaceChildren(); if (!preview) return;
    previewHost.append(line(`${preview.count} 件のお気に入りを読み込みました。追加する前に確認してください。`), line('同じURLがある場合は既存のお気に入りを保持します。'));
    const samples = document.createElement('ul');
    for (const item of preview.items.slice(0, 5)) { const node = document.createElement('li'); node.textContent = `${item.title || item.url} · ${item.folder || '未分類'}`; samples.append(node); }
    previewHost.append(samples, control('確認して統合', () => mutate('browser_import_favorites', {input: preview.input}, 'お気に入りを統合しました。')), control('取り込みをキャンセル', () => { preview = null; file.value = ''; renderPreview(); }));
  }
  const exportButton = button('JSONを書き出す', async () => {
    if (!live() || busy || stale) return;
    busy = true; render(); let url;
    try {
      const input = await invoke('browser_export_favorites'); if (!live()) return;
      if (typeof input !== 'string') throw Error('invalid_favorites_export');
      url = window.URL.createObjectURL(new window.Blob([input], {type:'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = 'hub-favorites.json'; root.append(link); link.click(); link.remove(); status.textContent = 'お気に入りを書き出しました。';
    } catch (error) { if (live()) failure(error, 'お気に入りを書き出せませんでした。'); }
    finally { if (url) window.URL.revokeObjectURL(url); busy = false; if (live()) render(); }
  });
  const importButton = button('JSONを取り込む', () => { if (live() && !busy && !stale) file.click(); });
  file.onchange = async () => {
    const turn = ++fileTurn, selected = file.files?.[0]; preview = null; renderPreview();
    if (!selected || !live() || busy) return;
    if (selected.size > MAX_IMPORT_BYTES) { status.textContent = '1 MiB以下のJSONファイルを選んでください。'; return; }
    try {
      const input = await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('favorites_file_read_failed')); reader.readAsText(selected); });
      if (turn !== fileTurn || !live()) return;
      const parsed = JSON.parse(input), incoming = Array.isArray(parsed) ? parsed : parsed?.version === 1 ? parsed.items : null;
      if (!Array.isArray(incoming) || incoming.length > 1000 || incoming.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !validUrl(item.url) || !validText(item.title, 300) || (item.folder !== undefined && !validText(item.folder, 80)))) throw Error('invalid_favorites_import');
      preview = {input, count: incoming.length, items: incoming}; status.textContent = 'ファイルの確認ができました。統合するとこのPCに保存します。'; renderPreview();
    } catch (error) { if (turn === fileTurn && live()) failure(error, 'お気に入りのJSONを読み込めませんでした。形式を確認してください。'); }
    finally { if (turn === fileTurn) file.value = ''; }
  };
  search.oninput = () => { query = search.value.trim().toLocaleLowerCase(); render(); };
  folders.onchange = () => { folder = folders.value === '' ? null : JSON.parse(folders.value); render(); };
  transfer.append(exportButton, importButton, file); renderFolders(); render(); return {reload};
}

function validText(value, limit) { return typeof value === 'string' && [...value].length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value); }
function validUrl(value) {
  if (typeof value !== 'string' || new Blob([value]).size > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
