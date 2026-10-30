// 外観の設定（この端末だけ・localStorage の hub.desktop.appearance）。
// 起動時の適用は appearance-early.js（最初の描画の前）が同じ規則で行う。ここは画面の操作と保存を持つ。
export const APPEARANCE_KEY = 'hub.desktop.appearance';

// 既定は今までの見た目（引き締まった黒）。システム連動は選んだ人だけ。
export const APPEARANCE_DEFAULTS = Object.freeze({ theme: 'dark', palette: 'standard', textSize: 'normal', density: 'normal', reduceMotion: false, reduceTransparency: false });
export const APPEARANCE_CHOICES = Object.freeze({
  theme: [['dark', 'ダーク'], ['light', 'ライト'], ['system', 'システムに合わせる']],
  palette: [['standard', '標準'], ['gold-ivory', 'ゴールド']],
  textSize: [['normal', '標準'], ['large', '大'], ['xlarge', '特大']],
  density: [['normal', '標準'], ['roomy', 'ゆったり']],
});

export function normalizeAppearance(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const pick = (key) => (APPEARANCE_CHOICES[key].some(([id]) => id === value[key]) ? value[key] : APPEARANCE_DEFAULTS[key]);
  return { theme: pick('theme'), palette: pick('palette'), textSize: pick('textSize'), density: pick('density'), reduceMotion: value.reduceMotion === true, reduceTransparency: value.reduceTransparency === true };
}

export function loadAppearance(storage) {
  try {
    const text = storage?.getItem(APPEARANCE_KEY);
    return normalizeAppearance(text ? JSON.parse(text) : null);
  } catch { return normalizeAppearance(null); }
}

export function saveAppearance(storage, prefs) {
  try { storage?.setItem(APPEARANCE_KEY, JSON.stringify(normalizeAppearance(prefs))); return true; } catch { return false; }
}

/** 実際に塗る配色。system は OS の設定で ライト/ダーク に解決する。 */
export function resolveTheme(theme, prefersDark) {
  if (theme === 'light') return 'light';
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return 'dark';
}

export function applyAppearance(root, prefs, prefersDark) {
  const value = normalizeAppearance(prefs);
  root.setAttribute('data-theme', resolveTheme(value.theme, prefersDark));
  root.setAttribute('data-theme-mode', value.theme);
  if (value.palette === 'gold-ivory') root.setAttribute('data-palette', 'gold-ivory'); else root.removeAttribute('data-palette');
  root.setAttribute('data-text-size', value.textSize);
  root.setAttribute('data-density', value.density);
  if (value.reduceMotion) root.setAttribute('data-motion', 'reduce'); else root.removeAttribute('data-motion');
  if (value.reduceTransparency) root.setAttribute('data-transparency', 'reduce'); else root.removeAttribute('data-transparency');
  return value;
}

/**
 * 設定画面の「外観」節。選ぶとすぐ反映して保存する。
 * host に選択肢を描く。storage / media は注入できる（検査用）。
 */
export function createAppearanceSettings({ document, storage, media = null }) {
  const root = document.documentElement;
  let prefs = loadAppearance(storage);
  const darkQuery = media ?? (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null);
  const prefersDark = () => darkQuery?.matches === true;
  const apply = () => applyAppearance(root, prefs, prefersDark());
  apply();
  darkQuery?.addEventListener?.('change', () => { if (prefs.theme === 'system') apply(); });

  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const element = make('div', undefined, 'appearance-settings');
  const row = (label, desc, control, extra = {}) => {
    const node = make(control.type === 'checkbox' ? 'label' : 'div', undefined, `setting-row${extra.className ? ' ' + extra.className : ''}`);
    node.dataset.setting = label;
    if (extra.keywords) node.dataset.keywords = extra.keywords;
    const text = make('span', undefined, 'setting-text');
    text.append(make('span', label, 'setting-label'), make('span', desc, 'setting-desc'));
    const wrap = make('span', undefined, 'setting-control');
    wrap.append(control);
    node.append(text, wrap);
    return node;
  };
  const groups = [
    ['theme', '配色', '明るい画面か暗い画面か。「システムに合わせる」はパソコンの設定に従います。', 'ダーク ライト テーマ 色 暗い 明るい'],
    ['palette', '色合い', '「ゴールド」は象牙色の地に金を強調だけに使います。明るさは上の配色に従います。', 'ゴールド アイボリー 金 象牙 色合い パレット'],
    ['textSize', '文字の大きさ', '一覧・詳細・設定の文字を大きくします。サイドバー、ブラウザ、AIの画面は変わりません。', 'フォント サイズ 拡大'],
    ['density', '表示の余白', '「ゆったり」は余白とボタンを広げます。', '密度 余白 ゆったり'],
  ];
  const radios = new Map();
  for (const [key, label, hint, keywords] of groups) {
    const field = make('fieldset', undefined, 'appearance-choices');
    field.setAttribute('aria-label', label);
    for (const [id, text] of APPEARANCE_CHOICES[key]) {
      const item = make('label', undefined, 'appearance-choice');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = `appearance-${key}`; input.value = id;
      input.addEventListener('change', () => { if (!input.checked) return; prefs = { ...prefs, [key]: id }; commit(); });
      radios.set(`${key}:${id}`, input);
      item.append(input, make('span', text));
      field.append(item);
    }
    element.append(row(label, hint, field, { className: 'appearance-group', keywords }));
  }
  const motion = document.createElement('input');
  motion.type = 'checkbox';
  motion.addEventListener('change', () => { prefs = { ...prefs, reduceMotion: motion.checked }; commit(); });
  element.append(row('動きを減らす', '画面の動きや点滅を止めます。パソコン側で「アニメーションを減らす」がオンなら、これに関わらず減らします。', motion, { className: 'appearance-motion', keywords: 'アニメーション 点滅 モーション' }));
  const trans = document.createElement('input');
  trans.type = 'checkbox';
  trans.addEventListener('change', () => { prefs = { ...prefs, reduceTransparency: trans.checked }; commit(); });
  element.append(row('透けやぼかしをやめる', '半透明の面とぼかしをやめて、ふつうの色にします。パソコン側で透明効果がオフなら、これに関わらずやめます。', trans, { className: 'appearance-transparency', keywords: '透明度 透明 ぼかし 半透明 Mica' }));
  const state = make('p', '', 'meta');
  state.setAttribute('role', 'status');
  element.append(state);
  const reset = make('button', '標準に戻す', 'head-action btn btn-secondary');
  reset.type = 'button';
  reset.addEventListener('click', () => { prefs = normalizeAppearance(null); commit(); });
  element.append(reset);

  function paint() {
    for (const [key] of groups) for (const [id] of APPEARANCE_CHOICES[key]) radios.get(`${key}:${id}`).checked = prefs[key] === id;
    motion.checked = prefs.reduceMotion;
    trans.checked = prefs.reduceTransparency;
  }
  function commit() {
    apply(); paint();
    state.textContent = saveAppearance(storage, prefs) ? 'この端末に保存しました。' : '保存できませんでした。この起動中だけ有効です。';
  }
  paint();
  return { element, get value() { return { ...prefs }; }, refresh: paint };
}
