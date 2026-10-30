// Hub Desktop のキーボードの近道（DESKTOP_SPEC §2.7）。
// 判定は純粋な関数（shortcutFor）。DOM を触る実行側は installShortcuts にまとめる。
// ブラウザ画面の Ctrl+T/W/L/Tab/1-9・Alt+←→ は browser-workspace.mjs が先に処理して
// preventDefault する。ここでは defaultPrevented を見て二重に動かさない。
// Ctrl+K（素早く移動）は app.js 側の既存の処理。

export const SHORTCUT_HELP = [
  ['全体', [
    ['Ctrl+K', '素早く移動'],
    ['Ctrl+1 … 9', '左の帯の n 番目の画面を開く'],
    ['Ctrl+[ / Ctrl+]', '戻る / 進む（Alt+← / Alt+→ も）'],
    ['Ctrl+L', 'アドレスバーへ移る'],
    ['Ctrl+\\', '画面のサイドバーを開閉'],
    ['Ctrl+Shift+\\', '右列を開閉'],
    ['N', '投稿する（左の「投稿する」と同じ）'],
    ['Ctrl+N', '新規（フィードは投稿、記事は書く、AI は新しい作業）'],
    ['/', '画面の中の検索欄へ移る'],
    ['?', 'この一覧を開く'],
  ]],
  ['一覧', [
    ['j / k', '次 / 前の行'],
    ['l', 'いいね'],
    ['r', '返信'],
    ['b', '保存'],
    ['Enter', '開く'],
  ]],
  ['ブラウザ', [
    ['Ctrl+T / Ctrl+W', '新しいタブ / 閉じる'],
    ['Ctrl+Shift+T', '閉じたタブを復元'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', '次 / 前のタブ（Ctrl+PgDn / Ctrl+PgUp も）'],
    ['Alt+D / F6', 'アドレスバーへ移る'],
    ['Ctrl+D', 'お気に入りに追加・解除'],
    ['Ctrl+F5 / Ctrl+Shift+R', 'キャッシュを使わず再読み込み'],
  ]],
];

const TYPING = 'input,textarea,select,[contenteditable],[role="textbox"]';
export const LIST_ROW = '.post[tabindex], [data-list-row]';

export function isTyping(target) {
  return !!target && typeof target.closest === 'function' && !!target.closest(TYPING);
}

const BACKSLASH = new Set(['\\', '|', '¥']);

/**
 * キーイベントから動作名を決める。該当なしは null。
 * ctx: { typing, dialogOpen }
 */
export function shortcutFor(event, ctx = {}) {
  if (!event || typeof event.key !== 'string') return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (ctx.dialogOpen) return null;
  const key = event.key;
  const lower = key.toLowerCase();
  const mod = !!(event.ctrlKey || event.metaKey);
  if (mod && !event.altKey) {
    if (!event.shiftKey && /^[1-9]$/.test(key)) return `screen-${key}`;
    if (!event.shiftKey && key === '[') return 'back';
    if (!event.shiftKey && key === ']') return 'forward';
    if (!event.shiftKey && lower === 'l') return 'address';
    if (!event.shiftKey && lower === 'n') return 'new';
    if (BACKSLASH.has(key) || event.code === 'Backslash' || event.code === 'IntlYen' || event.code === 'IntlRo') return event.shiftKey ? 'rail' : 'sidebar';
    return null;
  }
  if (event.altKey && !mod && !event.shiftKey) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    return null;
  }
  if (mod || event.altKey || ctx.typing) return null;
  // 一文字の近道は、入力欄の外・変換中でないときだけ。
  if (key === '/') return 'search';
  if (key === '?') return 'help';
  if (event.shiftKey) return null;
  switch (lower) {
    case 'j': return 'row-next';
    case 'k': return 'row-previous';
    case 'l': return 'row-like';
    case 'r': return 'row-reply';
    case 'b': return 'row-save';
    case 'n': return 'compose';
    default: break;
  }
  if (key === 'Enter') return 'row-open';
  return null;
}

const visible = (element) => !!element && !element.hidden && element.getClientRects().length > 0;

export function installShortcuts({ document, getView = () => '', announce = () => {} }) {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const activeView = () => $('.view.on') ?? document;
  const click = (element) => { if (element && !element.disabled) { element.click(); return true; } return false; };

  function rows() { return $$(LIST_ROW, activeView()).filter(visible); }
  function currentRow() {
    const focused = document.activeElement;
    return focused && typeof focused.closest === 'function' ? focused.closest(LIST_ROW) : null;
  }
  function moveRow(step) {
    const list = rows();
    if (!list.length) return false;
    const at = list.indexOf(currentRow());
    const next = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + step))];
    if (!next.hasAttribute('tabindex')) next.tabIndex = -1;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
    return true;
  }
  function rowButton(row, label, index) {
    const buttons = $$('.post-action', row);
    return buttons.find((button) => (button.getAttribute('aria-label') ?? '').includes(label)) ?? buttons[index] ?? null;
  }
  function rowAction(label, index) {
    const row = currentRow();
    return row ? click(rowButton(row, label, index)) : false;
  }
  function focusField(selector, root = activeView()) {
    const field = $$(selector, root).find(visible);
    if (!field) return false;
    field.focus();
    if (typeof field.select === 'function') field.select();
    return true;
  }
  function help() {
    let dialog = $('#shortcuts-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'shortcuts-dialog';
      dialog.className = 'shortcuts-dialog';
      dialog.setAttribute('aria-label', 'キーボードの近道');
      const title = document.createElement('h2');
      title.textContent = 'キーボードの近道';
      dialog.append(title);
      for (const [group, items] of SHORTCUT_HELP) {
        const heading = document.createElement('h3');
        heading.textContent = group;
        const list = document.createElement('dl');
        for (const [keys, label] of items) {
          const dt = document.createElement('dt');
          const kbd = document.createElement('kbd');
          kbd.textContent = keys;
          dt.append(kbd);
          const dd = document.createElement('dd');
          dd.textContent = label;
          list.append(dt, dd);
        }
        dialog.append(heading, list);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ds-btn ds-btn-plain';
      close.textContent = '閉じる';
      close.addEventListener('click', () => dialog.close());
      dialog.append(close);
      document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
    return true;
  }

  const actions = {
    back() {
      if (getView() === 'browser') return click($('#browser-back'));
      return click($('#toolbar-back'));
    },
    forward() {
      if (getView() === 'browser') return click($('#browser-forward'));
      return click($('#toolbar-forward'));
    },
    address() {
      if (getView() === 'browser') return focusField('#browser-url', document);
      return focusField('#toolbar-search-input', document);
    },
    sidebar() {
      // 内側左列の開閉は左上の1つだけ（2026-10-15、旦那様「開閉が二個ある」）。
      return click($('#toolbar-sidebar'));
    },
    rail() {
      const toggle = $$('#rail-activity-toggle, .desktop-rail-toggle, #toolbar-rail').find(visible);
      return click(toggle);
    },
    new() {
      const view = getView();
      if (view === 'feed') return focusField('#composer-text', document);
      if (view === 'articles') return click($('#articles-create-toggle'));
      if (view === 'ai') return click($('#sidebar-ai-new'));
      return false;
    },
    compose() {
      return click($('#desktop-compose'));
    },
    search() {
      return focusField('input[type="search"], input[type="text"][id*="query"]') || focusField('#toolbar-search-input', document);
    },
    help,
    'row-next': () => moveRow(1),
    'row-previous': () => moveRow(-1),
    'row-like': () => rowAction('いいね', 2),
    'row-reply': () => rowAction('返信', 0),
    'row-save': () => rowAction('ブックマーク', 3),
    'row-open'() {
      const row = currentRow();
      if (!row || document.activeElement !== row) return false;
      row.click();
      return true;
    },
  };

  function run(action) {
    const screen = /^screen-([1-9])$/.exec(action);
    if (screen) {
      const items = $$('.icon-rail .icon-nav-item[data-view]').filter((item) => !item.hidden);
      return click(items[Number(screen[1]) - 1]);
    }
    const handler = actions[action];
    return handler ? !!handler() : false;
  }

  const listener = (event) => {
    if (event.defaultPrevented) return;
    const action = shortcutFor(event, {
      typing: isTyping(event.target),
      dialogOpen: !!$('dialog[open]'),
    });
    if (!action) return;
    // 行の操作は、行が選ばれていないときは何もせず、既定の動作（Enter など）を残す。
    if (action.startsWith('row-') && action !== 'row-next' && action !== 'row-previous' && !currentRow()) return;
    if ((action === 'row-next' || action === 'row-previous') && !rows().length) return;
    if (run(action)) { event.preventDefault(); announce(action); }
  };
  document.addEventListener('keydown', listener);
  return { run, dispose: () => document.removeEventListener('keydown', listener) };
}
