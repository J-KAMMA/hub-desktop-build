import { normalizeHubSearchFilters, hasHubSearchFilters } from './hub-search-filters.mjs';

const languages = [['', 'すべての言語'], ['ja', '日本語'], ['en', '英語'], ['ko', '韓国語'], ['zh-CN', '中国語（簡体字）'], ['es', 'スペイン語'], ['fr', 'フランス語'], ['de', 'ドイツ語'], ['pt', 'ポルトガル語'], ['ar', 'アラビア語'], ['hi', 'ヒンディー語'], ['other', 'その他']];
const types = [['', 'すべての種別'], ['boards', '掲示板'], ['profiles', '人物'], ['threads', 'スレッド'], ['posts', '投稿'], ['images', '画像'], ['hubpedia', 'Hubpedia'], ['communities', 'コミュニティ'], ['videos', '動画'], ['lists', 'リスト'], ['tokens', 'トークン'], ['work', '仕事'], ['listings', '出品']];
const filterKeys = ['from', 'to', 'maxPrice', 'currency', 'language', 'region', 'category', 'type'];
const orderValue = value => { if (!['recommended', 'kind'].includes(value)) throw Error('invalid_order'); return value; };

export function createHubSearchFilters(document, { onApply = () => {}, onChange = () => {} } = {}) {
  let disposed = false;
  const element = document.createElement('details'); element.className = 'settings-note hub-search-filter-panel';
  const summary = document.createElement('summary'); summary.textContent = '検索条件';
  const fields = document.createElement('div'), controls = {}, listeners = []; fields.className = 'hub-search-filter-fields';
  const error = document.createElement('p'); error.className = 'meta'; error.setAttribute('role', 'alert'); error.setAttribute('aria-live', 'polite'); error.hidden = true;
  const bind = (node, event, handler) => { node.addEventListener(event, handler); listeners.push([node, event, handler]); };
  const changed = () => { if (disposed) return; error.textContent = ''; error.hidden = true; onChange(); };
  function field(name, label, options = null, limit = null) {
    const row = document.createElement('label'); row.className = 'field';
    const caption = document.createElement('span'); caption.textContent = label;
    const input = document.createElement(options ? 'select' : 'input'); input.name = name; input.setAttribute('aria-label', label);
    if (options) for (const [value, text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
    else { input.type = 'text'; input.maxLength = limit; input.autocomplete = 'off'; }
    bind(input, options ? 'change' : 'input', changed); controls[name] = input; row.append(caption, input); fields.append(row); return input;
  }
  for (const [name, label] of [['from', '開始日'], ['to', '終了日']]) {
    const input = field(name, label, null, 10); input.inputMode = 'numeric'; input.placeholder = 'YYYY-MM-DD'; input.setAttribute('aria-label', `${label}（YYYY-MM-DD、日本時間）`);
  }
  field('maxPrice', '上限価格', null, 32).inputMode = 'decimal';
  field('currency', '通貨', [['JPY', 'JPY'], ['USD', 'USD'], ['EUR', 'EUR']]);
  field('language', '言語', languages);
  field('region', '地域', null, 80);
  field('category', 'カテゴリ', null, 80);
  field('type', '種別', types);
  field('order', '表示順', [['recommended', 'おすすめ順'], ['kind', '種別順']]);
  const note = document.createElement('p'); note.className = 'meta'; note.textContent = '条件を入力し、適用してください。価格は0以上。JPYは整数、USD・EURは小数2桁まで。期間は公開・更新日を日本時間で指定します。言語・地域・カテゴリが不明な結果は除きます。';
  const actions = document.createElement('div'); actions.className = 'actions';
  const button = label => { const node = document.createElement('button'); node.type = 'button'; node.className = 'head-action'; node.textContent = label; actions.append(node); return node; };
  const apply = button('条件を適用'), clear = button('条件を解除');
  element.append(summary, fields, note, error, actions);
  function invalid() { error.textContent = '検索条件が正しくありません。日付・価格・文字数と表示順を確認してください。'; error.hidden = false; element.open = true; }
  function value() {
    try { return { filters: normalizeHubSearchFilters(Object.fromEntries(filterKeys.map(key => [key, controls[key].value]))), order: orderValue(controls.order.value) }; }
    catch (cause) { if (!disposed) invalid(); throw cause; }
  }
  function setValue(snapshot, { notify = false } = {}) {
    if (disposed) return;
    let next;
    try {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw Error('invalid_snapshot');
      next = { filters: normalizeHubSearchFilters(Object.hasOwn(snapshot, 'filters') ? snapshot.filters : {}), order: orderValue(Object.hasOwn(snapshot, 'order') ? snapshot.order : 'recommended') };
    } catch (cause) { invalid(); throw cause; }
    for (const key of filterKeys) controls[key].value = next.filters[key] ?? '';
    controls.order.value = next.order; error.textContent = ''; error.hidden = true;
    summary.textContent = hasHubSearchFilters(next.filters) || next.order !== 'recommended' ? '検索条件 · 設定あり' : '検索条件';
    if (notify) onChange();
    return next;
  }
  function reset() { if (disposed) return; return setValue({ filters: {}, order: 'recommended' }, { notify: true }); }
  bind(apply, 'click', () => {
    if (disposed) return;
    let next; try { next = value(); } catch { return; }
    setValue(next); onApply(next);
  });
  bind(clear, 'click', () => { if (disposed) return; onApply(reset()); });
  setValue({ filters: {}, order: 'recommended' });
  return { element, value, reset, setValue, destroy() { if (disposed) return; disposed = true; listeners.forEach(([node, event, handler]) => node.removeEventListener(event, handler)); element.remove(); } };
}
