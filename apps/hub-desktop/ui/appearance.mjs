// 外観の設定（この端末だけ）。色は localStorage の hub.desktop.template（テンプレートとくっきり表示）、
// 文字の大きさ・余白・動き・透明は hub.desktop.appearance。
// 起動時の適用は appearance-early.js（最初の描画の前）が同じ規則で行う。ここは画面の操作と保存を持つ。
export const APPEARANCE_KEY = 'hub.desktop.appearance';
export const TEMPLATE_KEY = 'hub.desktop.template';

// 5 つのカラーテンプレート（2026-11-02）。scheme は data-theme（明暗）。色の値は tokens.css の [data-template] にだけある。
export const TEMPLATES = Object.freeze([
  Object.freeze({ id: 'light', name: 'Light', scheme: 'light' }),
  Object.freeze({ id: 'dark', name: 'Dark', scheme: 'dark' }),
  Object.freeze({ id: 'noir', name: 'Noir', scheme: 'dark' }),
  Object.freeze({ id: 'ivory', name: 'Ivory', scheme: 'light' }),
  Object.freeze({ id: 'midnight', name: 'Midnight', scheme: 'dark' }),
]);
export const DEVICE_TEMPLATE = 'device'; // 端末に合わせる: Windows が明るければ light、暗ければ dark
export const DEFAULT_TEMPLATE = 'noir';

// 既定は今までの見た目（黒金のダーク＝noir）。
export const APPEARANCE_DEFAULTS = Object.freeze({ template: DEFAULT_TEMPLATE, crisp: false, textSize: 'normal', density: 'normal', reduceMotion: false, reduceTransparency: false });
export const APPEARANCE_CHOICES = Object.freeze({
  textSize: [['normal', '標準'], ['large', '大'], ['xlarge', '特大']],
  density: [['normal', '標準'], ['roomy', 'ゆったり']],
});

const isTemplate = (id) => id === DEVICE_TEMPLATE || TEMPLATES.some((t) => t.id === id);

/** 旧い theme / palette の保存から新しいテンプレートへ。黒金ダーク→noir、黒金ライト→ivory、白黒ライト→light、白黒ダーク→dark。 */
export function migrateTemplate(old) { return legacyTemplate(old) ?? DEFAULT_TEMPLATE; }
/** 旧い保存に色の選択があればその移行先、なければ null。 */
export function legacyTemplate(old) {
  if (old === null || typeof old !== 'object') return null;
  const theme = old.theme === 'light' || old.theme === 'system' || old.theme === 'dark' ? old.theme : null;
  const gold = old.palette === 'gold-ivory';
  if (theme === null && !gold && old.palette !== 'standard') return null; // 色を選んだことが無い
  if (theme === 'system') return DEVICE_TEMPLATE;
  if (theme === 'light') return gold ? 'ivory' : 'light';
  return gold ? 'noir' : 'dark';
}

export function normalizeAppearance(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const pick = (key) => (APPEARANCE_CHOICES[key].some(([id]) => id === value[key]) ? value[key] : APPEARANCE_DEFAULTS[key]);
  return { template: isTemplate(value.template) ? value.template : DEFAULT_TEMPLATE, crisp: value.crisp === true, textSize: pick('textSize'), density: pick('density'), reduceMotion: value.reduceMotion === true, reduceTransparency: value.reduceTransparency === true };
}

const readJson = (storage, key) => {
  try { const text = storage?.getItem(key); return text ? JSON.parse(text) : null; } catch { return null; }
};

/** 保存を読む。テンプレートの保存が無く、旧い theme / palette があれば 1 度だけ移して新しい鍵に書く。 */
export function loadAppearance(storage) {
  const base = readJson(storage, APPEARANCE_KEY);
  const saved = readJson(storage, TEMPLATE_KEY);
  let template; let crisp = false;
  if (saved !== null && typeof saved === 'object') {
    template = isTemplate(saved.template) ? saved.template : DEFAULT_TEMPLATE;
    crisp = saved.crisp === true;
  } else {
    const legacy = legacyTemplate(base);
    template = legacy ?? DEFAULT_TEMPLATE;
    if (legacy !== null) {
      try { storage?.setItem(TEMPLATE_KEY, JSON.stringify({ template, crisp })); } catch { /* 書けなくてもこの起動では効く */ }
    }
  }
  return normalizeAppearance({ ...(base !== null && typeof base === 'object' ? base : {}), template, crisp });
}

export function saveAppearance(storage, prefs) {
  const { template, crisp, ...rest } = normalizeAppearance(prefs);
  try {
    storage?.setItem(TEMPLATE_KEY, JSON.stringify({ template, crisp }));
    storage?.setItem(APPEARANCE_KEY, JSON.stringify(rest));
    return true;
  } catch { return false; }
}

/** 実際に塗るテンプレート。device は OS の設定で light / dark に解決する。 */
export function resolveTemplate(template, prefersDark) {
  if (template === DEVICE_TEMPLATE) return prefersDark ? 'dark' : 'light';
  return TEMPLATES.some((t) => t.id === template) ? template : DEFAULT_TEMPLATE;
}
export const templateScheme = (id) => TEMPLATES.find((t) => t.id === id)?.scheme ?? 'dark';

export function applyAppearance(root, prefs, prefersDark) {
  const value = normalizeAppearance(prefs);
  const id = resolveTemplate(value.template, prefersDark);
  const scheme = templateScheme(id);
  root.setAttribute('data-template', id);
  root.setAttribute('data-theme', scheme);
  root.setAttribute('data-theme-mode', value.template === DEVICE_TEMPLATE ? 'system' : scheme);
  root.removeAttribute('data-palette');
  if (value.crisp) root.setAttribute('data-crisp', ''); else root.removeAttribute('data-crisp');
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
  darkQuery?.addEventListener?.('change', () => { if (prefs.template === DEVICE_TEMPLATE) apply(); });

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
    ['textSize', '文字の大きさ', '一覧・詳細・設定の文字を大きくします。サイドバー、ブラウザ、AIの画面は変わりません。', 'フォント サイズ 拡大'],
    ['density', '表示の余白', '「ゆったり」は余白とボタンを広げます。', '密度 余白 ゆったり'],
  ];
  // カラーテンプレート: 見本ボタン 5 つと「端末に合わせる」で 1 つだけ選ぶ。見本の中は data-template で、そのテンプレートの色になる。
  const swatches = new Map();
  const picker = make('div', undefined, 'template-swatches');
  picker.setAttribute('role', 'radiogroup');
  picker.setAttribute('aria-label', 'カラーテンプレート');
  const chip = (id) => {
    const node = make('span', undefined, 'template-chip');
    node.dataset.template = id;
    node.append(make('span', 'Aa', 'template-chip-text'), make('span', undefined, 'template-chip-line'));
    node.setAttribute('aria-hidden', 'true');
    return node;
  };
  for (const entry of [...TEMPLATES, { id: DEVICE_TEMPLATE, name: '端末に合わせる' }]) {
    const button = make('button', undefined, 'template-swatch');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.dataset.templateChoice = entry.id;
    if (entry.id === DEVICE_TEMPLATE) {
      const pair = make('span', undefined, 'template-chip template-chip-device');
      pair.setAttribute('aria-hidden', 'true');
      pair.append(chip('light'), chip('dark'));
      button.append(pair);
    } else {
      button.append(chip(entry.id));
    }
    button.append(make('span', entry.name, 'template-name'));
    button.addEventListener('click', () => { prefs = { ...prefs, template: entry.id }; commit(); });
    swatches.set(entry.id, button);
    picker.append(button);
  }
  element.append(row('カラーテンプレート', '画面全体の色を 1 つ選びます。「端末に合わせる」はWindowsの設定に従い、明るければ Light、暗ければ Dark にします。', picker, { className: 'appearance-group appearance-template', keywords: 'テンプレート 配色 テーマ 色 ライト ダーク ノワール アイボリー ミッドナイト 端末に合わせる 暗い 明るい ゴールド 金' }));
  const crisp = document.createElement('input');
  crisp.type = 'checkbox';
  crisp.addEventListener('change', () => { prefs = { ...prefs, crisp: crisp.checked }; commit(); });
  element.append(row('くっきり表示', 'どのテンプレートでも、文字と線のコントラストを強めます。色合いは変わりません。', crisp, { className: 'appearance-crisp', keywords: 'くっきり コントラスト 見やすい 高コントラスト 文字 線' }));
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
    for (const [id, button] of swatches) {
      const on = prefs.template === id;
      button.setAttribute('aria-checked', String(on));
    }
    for (const node of picker.querySelectorAll('.template-chip')) { if (prefs.crisp) node.setAttribute('data-crisp', ''); else node.removeAttribute('data-crisp'); }
    crisp.checked = prefs.crisp;
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

/** 互換: 旧い resolveTheme(theme, prefersDark)。明暗（light / dark）だけを返す。新しい処理は resolveTemplate を使う。 */
export function resolveTheme(theme, prefersDark) {
  if (theme === 'light') return 'light';
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return 'dark';
}
