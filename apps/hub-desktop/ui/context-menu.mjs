// 右クリックのメニュー（DESKTOP_SPEC §2.8）。Hub の画面（この窓の DOM）だけが対象。
// 外部サイトは別の子 WebView なので、ここには届かない。
// 項目が無い場所でも WebView 既定のメニューは出さない。
// 他のレーンは register((target, event) => items | null) で場所ごとの項目を足せる。
// 項目: { label, run, keys?, disabled? } または '-'（区切り線）。

const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]';
const clean = (value) => (typeof value === 'string' ? value.trim() : '');

export function httpUrl(value, base = 'http://tauri.localhost/') {
  try {
    const url = new URL(clean(value), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch { return null; }
}

/**
 * 既定の項目を作る。isHubUrl は Hub の Web ページか（その URL はアプリ内ブラウザで開かず、
 * 既定のブラウザへ渡すだけにする）。
 */
export function defaultItems(target, { selection = '', isHubUrl = () => false, openTab, openExternal, copy, paste, editCommand } = {}) {
  const items = [];
  const add = (...entries) => { if (items.length && entries.length) items.push('-'); items.push(...entries); };
  const field = target?.closest?.(FIELD);
  if (field) {
    const readonly = field.readOnly || field.disabled;
    const hasSelection = typeof field.selectionStart === 'number' ? field.selectionStart !== field.selectionEnd : !!selection;
    add(
      { label: '切り取り', keys: 'Ctrl+X', disabled: readonly || !hasSelection, run: () => editCommand?.('cut') },
      { label: 'コピー', keys: 'Ctrl+C', disabled: !hasSelection, run: () => editCommand?.('copy') },
      { label: '貼り付け', keys: 'Ctrl+V', disabled: readonly, run: () => paste?.(field) },
      { label: 'すべて選択', keys: 'Ctrl+A', run: () => { field.focus(); field.select?.(); } },
    );
    return items;
  }
  const anchor = target?.closest?.('a[href]');
  const link = anchor ? httpUrl(anchor.getAttribute('href'), anchor.baseURI) : null;
  if (link) {
    if (isHubUrl(link)) add({ label: '既定のブラウザで開く', run: () => openExternal?.(link.href) });
    else add(
      { label: '新しいタブで開く', run: () => openTab?.(link.href) },
      { label: '既定のブラウザで開く', run: () => openExternal?.(link.href) },
    );
    add({ label: 'リンクのアドレスをコピー', run: () => copy?.(link.href) });
  }
  const image = target?.closest?.('img[src]');
  const source = image ? httpUrl(image.currentSrc || image.getAttribute('src'), image.baseURI) : null;
  if (source) {
    if (isHubUrl(source)) add({ label: '画像を既定のブラウザで開く', run: () => openExternal?.(source.href) });
    else add({ label: '画像を新しいタブで開く', run: () => openTab?.(source.href) });
    add({ label: '画像のアドレスをコピー', run: () => copy?.(source.href) });
  }
  if (clean(selection)) add({ label: 'コピー', keys: 'Ctrl+C', run: () => copy?.(selection) });
  return items;
}

export function installContextMenu({ document, window = document.defaultView, isHubUrl, openTab, openExternal } = {}) {
  const providers = [];
  let menu = null;
  let opener = null;

  const copy = async (text) => {
    try { await window.navigator.clipboard.writeText(text); } catch { /* 権限が無いときは何もしない */ }
  };
  const paste = async (field) => {
    try {
      const text = await window.navigator.clipboard.readText();
      field.focus();
      if (!document.execCommand?.('insertText', false, text) && typeof field.setRangeText === 'function') field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
    } catch { /* 権限が無いときは何もしない */ }
  };
  const editCommand = (name) => { try { document.execCommand?.(name); } catch { /* 何もしない */ } };

  function close(restore = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    for (const type of ['pointerdown', 'scroll', 'resize', 'blur']) window.removeEventListener(type, onOutside, true);
    if (restore && opener?.isConnected) opener.focus?.();
    opener = null;
  }
  function onOutside(event) {
    if (event.type === 'pointerdown' && menu?.contains(event.target)) return;
    if (event.type === 'blur' && event.target !== window) return;
    if (event.type === 'scroll' && menu?.contains(event.target)) return;
    close();
  }
  function entries(event) {
    const target = event.target instanceof window.Element ? event.target : null;
    const selection = String(window.getSelection?.() ?? '');
    for (const provider of providers) {
      const own = provider(target, event);
      if (Array.isArray(own) && own.length) return own;
    }
    return defaultItems(target, { selection, isHubUrl, openTab, openExternal, copy, paste, editCommand });
  }
  function open(items, x, y) {
    close();
    opener = document.activeElement;
    menu = document.createElement('div');
    menu.className = 'ds-menu context-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    for (const item of items) {
      if (item === '-') {
        const sep = document.createElement('div');
        sep.className = 'ds-menu-sep';
        sep.setAttribute('role', 'separator');
        menu.append(sep);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ds-menu-item';
      button.setAttribute('role', 'menuitem');
      button.disabled = !!item.disabled;
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(label);
      if (item.keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = item.keys;
        button.append(kbd);
      }
      button.addEventListener('click', () => { close(true); void item.run?.(); });
      menu.append(button);
    }
    menu.addEventListener('keydown', (event) => {
      const buttons = [...menu.querySelectorAll('.ds-menu-item:not(:disabled)')];
      const at = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') { close(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(at + 1) % buttons.length]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(at - 1 + buttons.length) % buttons.length]?.focus(); }
      else if (event.key === 'Home') { event.preventDefault(); buttons[0]?.focus(); }
      else if (event.key === 'End') { event.preventDefault(); buttons.at(-1)?.focus(); }
    });
    menu.style.position = 'fixed';
    menu.style.zIndex = '70';
    document.body.append(menu);
    const width = menu.offsetWidth || 200, height = menu.offsetHeight || 0;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
    menu.focus({ preventScroll: true });
    for (const type of ['pointerdown', 'scroll', 'resize', 'blur']) window.addEventListener(type, onOutside, true);
  }

  const listener = (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const items = entries(event);
    if (!items.length) { close(); return; }
    const x = event.clientX > 0 || event.clientY > 0 ? event.clientX : 24;
    const y = event.clientX > 0 || event.clientY > 0 ? event.clientY : 24;
    open(items, x, y);
  };
  document.addEventListener('contextmenu', listener);
  return {
    register(provider) { providers.push(provider); return () => providers.splice(providers.indexOf(provider), 1); },
    close,
    isOpen: () => !!menu,
    dispose() { close(); document.removeEventListener('contextmenu', listener); },
  };
}
