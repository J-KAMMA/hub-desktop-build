// 設定「この端末」の「手元のデータを消す」と、Node の鍵の控え、ウォレットの鍵の削除。
// 決定は docs/hub-desktop-local-data/INVENTORY.md（2026-10-18）。ウォレットの鍵は「まとめて消す」に入れない。
import { confirmInline, settingHeader } from './settings-view.mjs';

export const WALLET_CONFIRMATION = 'ウォレットを消す';

const make = (document, tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

async function removeAiConnections(invoke) {
  const list = await invoke('byok_list');
  const connections = Array.isArray(list?.connections) ? list.connections : null;
  if (!connections) throw new Error('unreadable');
  for (const connection of connections) {
    if (typeof connection?.id === 'string' && connection.id) await invoke('byok_remove', { id: connection.id });
  }
}

/** 消せる種類。順番は画面の並びと実行の順。 */
export const LOCAL_DATA_KINDS = Object.freeze([
  { key: 'history', label: '閲覧履歴', desc: 'ページとダウンロードの記録。前回のタブも開き直しません。',
    run: (invoke) => invoke('browser_clear_browsing_data', { kinds: ['history', 'downloads_history'] }) },
  { key: 'cookies', label: 'Cookie とサイトデータ', desc: 'ログイン中のサイトからはログアウトされます。',
    run: (invoke) => invoke('browser_clear_browsing_data', { kinds: ['cookies', 'site_storage'] }) },
  { key: 'cache', label: 'キャッシュ', desc: '次に開くとまた読み込みます。',
    run: (invoke) => invoke('browser_clear_browsing_data', { kinds: ['cache'] }) },
  { key: 'ai', label: 'AIの作業記録', desc: 'AIとの作業の会話・添付した画像・作業の一覧と、開発CLIの実行記録です。実行中の作業は残ります。',
    run: (invoke) => invoke('pi_work_delete_all') },
  { key: 'keys', label: 'AIの接続（キー）', desc: '登録したAPIキーと接続の設定です。使うには、もう一度登録します。',
    run: removeAiConnections },
  { key: 'node', label: 'Personal Node のデータ', desc: 'Node の記録・作品・受け取った曲と、Node の鍵です。次に起動したときに消えます。鍵を残したいときは、先に下で控えを書き出してください。',
    run: (invoke) => invoke('local_data_schedule_wipe', { kinds: ['node'] }) },
]);

function restartButton(document, invoke, state) {
  const restart = make(document, 'button', '今すぐ再起動', 'btn btn-secondary'); restart.type = 'button';
  restart.addEventListener('click', async () => {
    restart.disabled = true;
    try { await invoke('local_data_restart'); } catch { state.textContent = '再起動できませんでした。アプリを閉じて、開き直してください。'; restart.disabled = false; }
  });
  return restart;
}

/** 種類ごとに選んで消す。押すまで何も消さず、確認を同じ場所に出す。 */
export function createLocalDataPanel({ document, invoke, openWallet = () => {} }) {
  const element = make(document, 'div', undefined, 'local-data-settings');
  element.append(clearCard(document, invoke), backupCard(document, invoke), walletCard(document, invoke, openWallet));
  return { element };
}

function clearCard(document, invoke) {
  const card = make(document, 'div', undefined, 'card');
  card.append(settingHeader(document, { label: '手元のデータを消す', desc: 'この端末に残っているデータを、種類ごとに選んで消します。消したものは元に戻せません。', keywords: '削除 消去 履歴 Cookie キャッシュ AI キー Node 初期化' }));
  const boxes = new Map();
  for (const kind of LOCAL_DATA_KINDS) {
    const row = make(document, 'label', undefined, 'setting-row');
    row.dataset.localData = kind.key;
    const text = make(document, 'span', undefined, 'setting-text');
    text.append(make(document, 'span', kind.label, 'setting-label'), make(document, 'span', kind.desc, 'setting-desc'));
    const box = make(document, 'input'); box.type = 'checkbox';
    const control = make(document, 'span', undefined, 'setting-control'); control.append(box);
    row.append(text, control);
    boxes.set(kind.key, box);
    card.append(row);
  }
  card.append(make(document, 'p', 'ウォレットの鍵はここでは消しません。下の「ウォレットの鍵を消す」で別に扱います。', 'meta'));
  const actions = make(document, 'div', undefined, 'actions');
  const clear = make(document, 'button', '選んだデータを消す', 'deny btn btn-ghost'); clear.type = 'button'; clear.disabled = true;
  actions.append(clear);
  const confirmHost = make(document, 'div');
  const state = make(document, 'p', '', 'meta'); state.setAttribute('role', 'status');
  const after = make(document, 'div', undefined, 'actions'); after.hidden = true;
  card.append(actions, confirmHost, state, after);
  const chosen = () => LOCAL_DATA_KINDS.filter((kind) => boxes.get(kind.key).checked);
  for (const box of boxes.values()) box.addEventListener('change', () => { clear.disabled = chosen().length === 0; });
  clear.addEventListener('click', () => {
    const kinds = chosen();
    if (!kinds.length) return;
    confirmInline(document, confirmHost, {
      message: `次のデータを消します。元に戻せません：${kinds.map((kind) => kind.label).join('、')}`,
      yes: '消す',
      onYes: async () => {
        const done = [], failed = [];
        for (const kind of kinds) {
          try { await kind.run(invoke); done.push(kind); } catch { failed.push(kind); }
        }
        const node = done.some((kind) => kind.key === 'node');
        const names = (list) => list.map((kind) => kind.label).join('、');
        const now = done.filter((kind) => kind.key !== 'node');
        state.textContent = [
          now.length ? `消しました：${names(now)}` : '',
          node ? 'Personal Node のデータは、次に起動したときに消えます。' : '',
          failed.length ? `消せなかったもの：${names(failed)}` : '',
        ].filter(Boolean).join(' ');
        after.replaceChildren(...(node ? [restartButton(document, invoke, state)] : []));
        after.hidden = !node;
        for (const kind of done) boxes.get(kind.key).checked = false;
        clear.disabled = chosen().length === 0;
      },
    });
  });
  return card;
}

const BACKUP_ERRORS = Object.freeze({
  backup_password_too_short: 'パスワードは12文字以上にしてください。',
  backup_password_too_long: 'パスワードが長すぎます。',
  backup_password_wrong: 'パスワードが違うか、ファイルが壊れています。',
  backup_file_invalid: 'Node の鍵の控えとして読めないファイルです。',
  backup_file_unavailable: 'ファイルを読めませんでした。',
  backup_write_failed: 'ファイルを書き込めませんでした。',
  node_key_missing: '書き出せる Node の鍵が、まだこの端末にありません。',
  node_key_invalid: '鍵の中身を確かめられませんでした。',
});
const backupError = (error) => BACKUP_ERRORS[String(error?.message ?? error)] ?? 'できませんでした。';

function passwordField(document, label, autocomplete) {
  const row = make(document, 'label', undefined, 'setting-row is-stacked');
  const text = make(document, 'span', undefined, 'setting-text');
  text.append(make(document, 'span', label, 'setting-label'));
  const input = make(document, 'input'); input.type = 'password'; input.autocomplete = autocomplete; input.maxLength = 1024; input.spellcheck = false;
  row.append(text, input);
  return { row, input };
}

function backupCard(document, invoke) {
  const card = make(document, 'div', undefined, 'card');
  card.append(settingHeader(document, { label: 'Node の鍵の控え', desc: 'Personal Node の身元の鍵と暗号の鍵を、パスワードをかけたファイルに書き出します。この端末の鍵が読めなくなっても、取り込めば同じ Node に戻れます。', keywords: 'バックアップ 書き出し 取り込み 鍵 Node 復元' }));
  card.append(make(document, 'p', 'このファイルとパスワードの両方を持つ人は、あなたの Node になりすませます。ファイルとパスワードは別々の場所に置いてください。パスワードを忘れると、控えは使えません。', 'meta'));
  const first = passwordField(document, 'パスワード（12文字以上）', 'new-password');
  const second = passwordField(document, 'もう一度入力', 'new-password');
  const exportActions = make(document, 'div', undefined, 'actions');
  const exportButton = make(document, 'button', '控えを書き出す', 'btn btn-secondary'); exportButton.type = 'button';
  exportActions.append(exportButton);
  const importField = passwordField(document, '取り込む控えのパスワード', 'current-password');
  const importActions = make(document, 'div', undefined, 'actions');
  const importButton = make(document, 'button', '控えを取り込む', 'btn btn-secondary'); importButton.type = 'button';
  importActions.append(importButton);
  const confirmHost = make(document, 'div');
  const state = make(document, 'p', '', 'meta'); state.setAttribute('role', 'status');
  const after = make(document, 'div', undefined, 'actions'); after.hidden = true;
  card.append(first.row, second.row, exportActions, importField.row, importActions, confirmHost, state, after);
  exportButton.addEventListener('click', async () => {
    const password = first.input.value;
    if ([...password].length < 12) { state.textContent = BACKUP_ERRORS.backup_password_too_short; return; }
    if (password !== second.input.value) { state.textContent = '2つのパスワードが一致しません。'; return; }
    exportButton.disabled = true; state.textContent = '書き出しています…';
    try {
      const result = await invoke('node_key_backup_export', { password });
      state.textContent = result?.saved === true ? '書き出しました。ファイルとパスワードを別々に保管してください。' : '書き出しをやめました。';
      if (result?.saved === true) { first.input.value = ''; second.input.value = ''; }
    } catch (error) { state.textContent = backupError(error); }
    finally { exportButton.disabled = false; }
  });
  importButton.addEventListener('click', () => {
    if (!importField.input.value) { state.textContent = '控えのパスワードを入力してください。'; return; }
    confirmInline(document, confirmHost, {
      message: '今の Node の鍵を、控えの鍵に入れ替えます。今の鍵は消さずに別の場所へよけます。入れ替えた鍵は、次に起動したときから使います。',
      yes: '入れ替える',
      onYes: async () => {
        const password = importField.input.value;
        try {
          const result = await invoke('node_key_backup_import', { password });
          if (result?.imported === true) {
            importField.input.value = '';
            state.textContent = '取り込みました。再起動すると、取り込んだ鍵で動きます。';
            after.replaceChildren(restartButton(document, invoke, state)); after.hidden = false;
          } else state.textContent = '取り込みをやめました。';
        } catch (error) { state.textContent = backupError(error); }
      },
    });
  });
  return card;
}

/** ウォレットの鍵は、控えの確認と確認の言葉の入力を経たときだけ消す。 */
function walletCard(document, invoke, openWallet) {
  const card = make(document, 'div', undefined, 'card setting-danger-zone');
  card.append(settingHeader(document, { label: 'ウォレットの鍵を消す', desc: 'この端末に置いたウォレットの秘密鍵を消します。「選んだデータを消す」では消えません。', keywords: 'ウォレット 秘密鍵 削除 消す' }));
  const backup = make(document, 'div');
  backup.append(make(document, 'p', 'このアプリには、ウォレットの秘密鍵を書き出す機能がありません。控えのないまま消すと、このウォレットの資産は二度と動かせません。消す前に、ウォレットの画面で残高を別のウォレットへ送ってください。', 'meta'));
  const backupActions = make(document, 'div', undefined, 'actions');
  const open = make(document, 'button', 'ウォレットを開く', 'btn btn-secondary'); open.type = 'button';
  const next = make(document, 'button', '確かめたので次へ', 'btn btn-secondary'); next.type = 'button';
  backupActions.append(open, next); backup.append(backupActions);
  const confirmStep = make(document, 'div'); confirmStep.hidden = true;
  const checkRow = make(document, 'label', undefined, 'setting-row');
  const checkText = make(document, 'span', undefined, 'setting-text');
  checkText.append(make(document, 'span', '残高を移した。または、この鍵の控えを別に持っている', 'setting-label'));
  const checked = make(document, 'input'); checked.type = 'checkbox';
  const checkControl = make(document, 'span', undefined, 'setting-control'); checkControl.append(checked);
  checkRow.append(checkText, checkControl);
  const wordRow = make(document, 'label', undefined, 'setting-row is-stacked');
  const wordText = make(document, 'span', undefined, 'setting-text');
  wordText.append(make(document, 'span', `確かめるため「${WALLET_CONFIRMATION}」と入力してください`, 'setting-label'));
  const word = make(document, 'input'); word.type = 'text'; word.autocomplete = 'off'; word.spellcheck = false; word.maxLength = 32;
  wordRow.append(wordText, word);
  const deleteActions = make(document, 'div', undefined, 'actions');
  const remove = make(document, 'button', 'ウォレットの鍵を消す', 'deny btn btn-ghost'); remove.type = 'button'; remove.disabled = true;
  deleteActions.append(remove);
  confirmStep.append(checkRow, wordRow, deleteActions);
  const state = make(document, 'p', '', 'meta'); state.setAttribute('role', 'status');
  card.append(backup, confirmStep, state);
  const ready = () => checked.checked && word.value.trim() === WALLET_CONFIRMATION;
  const sync = () => { remove.disabled = !ready(); };
  open.addEventListener('click', () => openWallet());
  next.addEventListener('click', () => { confirmStep.hidden = false; word.focus?.(); });
  checked.addEventListener('change', sync);
  word.addEventListener('input', sync);
  remove.addEventListener('click', async () => {
    if (!ready()) return;
    remove.disabled = true;
    try {
      await invoke('wallet_delete_key', { confirmation: word.value.trim(), backedUp: true });
      state.textContent = 'ウォレットの鍵を消しました。';
      word.value = ''; checked.checked = false; confirmStep.hidden = true;
    } catch { state.textContent = '消せませんでした。'; sync(); }
  });
  return card;
}

/** 設定「AI」の「AIの作業記録をすべて消す」。 */
export function createAiRecordsPanel({ document, invoke, onDeleted = () => {} }) {
  const element = make(document, 'div', undefined, 'card');
  element.append(settingHeader(document, { label: 'AIの作業記録', desc: 'AIとの作業の会話・添付した画像・作業の一覧は、90日たつと自動で消えます。ファイルの変更前の版は、ファイルごとに新しい20件まで残します。', keywords: '作業記録 履歴 削除 保存期間 90日' }));
  const actions = make(document, 'div', undefined, 'actions');
  const clear = make(document, 'button', 'AIの作業記録をすべて消す', 'deny btn btn-ghost'); clear.type = 'button';
  actions.append(clear);
  const confirmHost = make(document, 'div');
  const state = make(document, 'p', '', 'meta'); state.setAttribute('role', 'status');
  element.append(actions, confirmHost, state);
  clear.addEventListener('click', () => confirmInline(document, confirmHost, {
    message: 'AIの作業記録をすべて消します。実行中の作業は残ります。元に戻せません。',
    yes: '消す',
    onYes: async () => {
      try { await invoke('pi_work_delete_all'); state.textContent = 'AIの作業記録を消しました。'; onDeleted(); }
      catch { state.textContent = '消せませんでした。'; }
    },
  }));
  return { element };
}
