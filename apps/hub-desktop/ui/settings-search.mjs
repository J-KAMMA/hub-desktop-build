// 設定の検索。ラベルと説明文に対する部分一致（日本語向けに表記ゆれを吸収する）。
// 画面の行（[data-setting]）を読むだけで、設定の値や保存先には触れない。

/** 全角半角・大文字小文字・カタカナ/ひらがなを揃え、空白を除く。 */
export function normalizeForSearch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');
}

/** 空白で区切った語を全部含む行だけを残す（AND）。空の検索は何も返さない。 */
export function matchSettings(items, query) {
  const terms = String(query ?? '').normalize('NFKC').split(/\s+/).map(normalizeForSearch).filter(Boolean);
  if (!terms.length) return [];
  return items.filter((item) => {
    const haystack = normalizeForSearch(`${item.label} ${item.desc} ${item.keywords ?? ''}`);
    return terms.every((term) => haystack.includes(term));
  });
}

/** 画面にある設定の行を集める。節の名前は左の一覧から引く。 */
export function collectSettingItems(document) {
  const names = new Map([...document.querySelectorAll('#view-settings .inner-nav-item')].map((n) => [n.dataset.settingsSec, n.textContent.trim()]));
  const items = [];
  for (const el of document.querySelectorAll('#view-settings [data-setting]')) {
    const panel = el.closest('[data-settings-panel]');
    if (!panel || panel.dataset.settingsPanel === 'search') continue;
    const section = panel.dataset.settingsPanel;
    items.push({
      el, section, sectionName: names.get(section) ?? '',
      label: el.querySelector('.setting-label')?.textContent.trim() ?? '',
      desc: el.querySelector('.setting-desc')?.textContent.trim() ?? '',
      keywords: el.dataset.keywords ?? '',
    });
  }
  return items;
}

/**
 * 左の一覧の上の検索欄。入力すると右に一致した項目の一覧を出し、押すとその節へ移ってその行を示す。
 * 矢印キーで欄と結果を行き来でき、Escape で消す。
 */
export function createSettingsSearch({ document, input, panel, nav, onResult = () => {} }) {
  const results = document.createElement('div');
  results.className = 'settings-results';
  results.setAttribute('role', 'list');
  const empty = document.createElement('p');
  empty.className = 'meta settings-empty';
  empty.setAttribute('role', 'status');
  panel.append(empty, results);

  function clear() {
    input.value = '';
    results.replaceChildren();
    empty.textContent = '';
    nav.leaveSearch();
  }
  function reveal(item) {
    clear();
    nav.select(item.section);
    item.el.scrollIntoView?.({ block: 'center' });
    item.el.classList.add('is-found');
    const control = item.el.querySelector('input, select, textarea, button');
    control?.focus?.({ preventScroll: true });
    setTimeout(() => item.el.classList.remove('is-found'), 2000);
    onResult(item);
  }
  function run() {
    const query = input.value;
    if (!query.trim()) { clear(); return; }
    const found = matchSettings(collectSettingItems(document), query);
    nav.enterSearch();
    results.replaceChildren(...found.map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-result';
      button.setAttribute('role', 'listitem');
      const name = document.createElement('span'); name.className = 'setting-label'; name.textContent = item.label;
      const where = document.createElement('span'); where.className = 'settings-result-where'; where.textContent = item.sectionName;
      const text = document.createElement('span'); text.className = 'setting-desc'; text.textContent = item.desc;
      button.append(name, where, text);
      button.addEventListener('click', () => reveal(item));
      return button;
    }));
    empty.textContent = found.length ? `${found.length}件見つかりました。` : '見つかりませんでした。別の言葉でお試しください。';
  }
  input.addEventListener('input', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); clear(); return; }
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      const first = results.querySelector('button');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  results.addEventListener('keydown', (event) => {
    const buttons = [...results.querySelectorAll('button')];
    const at = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' && at >= 0) { event.preventDefault(); buttons[Math.min(at + 1, buttons.length - 1)].focus(); }
    else if (event.key === 'ArrowUp' && at >= 0) { event.preventDefault(); (at === 0 ? input : buttons[at - 1]).focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); clear(); input.focus(); }
  });
  return { run, clear };
}
