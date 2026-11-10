// 設定画面の節の切り替えと、実在するコマンドだけにつながる各節。
// 通知と受信（hub_client settings）とメディア共有は app.js 側の既存の部品を使い、ここは onSelect で知らせる。
import { createWebSearchSetting } from './web-search.mjs';
const ACTOR_URL = /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/;

export function validActorUrl(value) {
  return typeof value === 'string' && value.length <= 2048 && ACTOR_URL.test(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '不明';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function builder(document) {
  return (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
}

/** 「やっていいですか」を同じ場所に出す二段階の確認。押すまで何も実行しない。 */
export function confirmInline(document, host, { message, yes, no = 'やめる', onYes }) {
  const make = builder(document);
  host.replaceChildren();
  const box = make('div', undefined, 'settings-confirm');
  box.setAttribute('role', 'alertdialog');
  box.append(make('p', message));
  const row = make('div', undefined, 'actions');
  const ok = make('button', yes, 'approve'); ok.type = 'button';
  const cancel = make('button', no, 'deny'); cancel.type = 'button';
  cancel.addEventListener('click', () => host.replaceChildren());
  ok.addEventListener('click', async () => {
    ok.disabled = true; cancel.disabled = true;
    try { await onYes(); } finally { host.replaceChildren(); }
  });
  row.append(ok, cancel);
  box.append(row);
  host.append(box);
  return box;
}

/** 昔の節の名前から今の節へ。他のコードが古い名前で開いても動くように残す。 */
export const SECTION_ALIASES = Object.freeze({ identity: 'advanced', about: 'advanced', other: 'advanced' });

/** いま本文に見えている節の名前。検索の結果を出している間は 'search'。 */
export function visibleSection(document) {
  return [...document.querySelectorAll('#view-settings [data-settings-panel]')].find((panel) => !panel.hidden)?.dataset.settingsPanel ?? null;
}

export function createSettingsNav({ document, onSelect = () => {} }) {
  const items = [...document.querySelectorAll('#view-settings .inner-nav-item')];
  const panels = () => [...document.querySelectorAll('#view-settings [data-settings-panel]')];
  let current = null;
  // 左の列（app.js）が強調を引き直せるよう、節が変わるたびに知らせる。開き方（列・検索・リンク・初期表示）を問わない。
  function announce() { document.dispatchEvent(new document.defaultView.CustomEvent('hub-settings-section', { detail: { section: visibleSection(document) } })); }
  function show(panelId) {
    for (const panel of panels()) panel.hidden = panel.dataset.settingsPanel !== panelId;
  }
  function select(section) {
    const panelId = SECTION_ALIASES[section] ?? section;
    const target = items.find((item) => item.dataset.settingsSec === panelId);
    if (!target) return false;
    current = panelId;
    for (const item of items) {
      const on = item === target;
      item.classList.toggle('on', on);
      if (on) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    }
    show(panelId);
    onSelect(panelId);
    announce();
    if (panelId !== section) document.querySelector(`#view-settings [data-settings-anchor="${section}"]`)?.scrollIntoView?.({ block: 'start' });
    return true;
  }
  // 検索中は右に結果の一覧を出す。左の一覧の強調は外す。
  function enterSearch() {
    for (const item of items) { item.classList.remove('on'); item.removeAttribute('aria-current'); }
    show('search');
    announce();
  }
  function leaveSearch() { if (current) select(current); }
  for (const item of items) item.addEventListener('click', () => select(item.dataset.settingsSec));
  return { select, enterSearch, leaveSearch, get current() { return current; } };
}

/**
 * 設定の1行。左にラベルと短い説明、右に操作。切り替え（チェックボックス）の行は全体を label にして、文字を押しても切り替わる。
 * data-setting は検索の対象の印。keywords は検索だけに使う言い換え。
 */
export function settingRow(document, { label, desc = '', control = null, keywords = '', stacked = false, danger = false, key = '' }) {
  const toggle = control?.tagName === 'INPUT' && control.type === 'checkbox';
  const row = document.createElement(toggle ? 'label' : 'div');
  row.className = `setting-row${stacked ? ' is-stacked' : ''}${danger ? ' is-danger' : ''}`;
  row.dataset.setting = key || label;
  if (keywords) row.dataset.keywords = keywords;
  const text = document.createElement('span');
  text.className = 'setting-text';
  const name = document.createElement('span'); name.className = 'setting-label'; name.textContent = label;
  text.append(name);
  if (desc) { const d = document.createElement('span'); d.className = 'setting-desc'; d.textContent = desc; text.append(d); }
  row.append(text);
  if (control) {
    if (control.parentNode !== row && !stacked) { const wrap = document.createElement('span'); wrap.className = 'setting-control'; wrap.append(control); row.append(wrap); }
    else row.append(control);
  }
  return row;
}

/** 節の中の群の見出し。検索で見つかる行も兼ねる（見出しと説明だけで、操作は持たない）。 */
export function settingHeader(document, { label, desc = '', keywords = '', key = '' }) {
  const head = document.createElement('div');
  head.className = 'setting-header';
  head.dataset.setting = key || label;
  if (keywords) head.dataset.keywords = keywords;
  const h = document.createElement('h3'); h.className = 'setting-label'; h.textContent = label;
  head.append(h);
  if (desc) { const d = document.createElement('p'); d.className = 'setting-desc'; d.textContent = desc; head.append(d); }
  return head;
}

/** 身元の鍵: 公開鍵の表示と、署名だけ。秘密鍵の書き出し・取り込みのコマンドは無い。 */
export function createIdentityPanel({ document, invoke }) {
  const make = builder(document);
  const element = make('div', undefined, 'settings-identity');
  const state = make('p', '読み込み中…', 'meta'); state.setAttribute('role', 'status');
  const did = make('input', undefined, 'settings-readonly'); did.readOnly = true; did.setAttribute('aria-label', '公開している根鍵（did:key）');
  const output = make('textarea', undefined, 'settings-readonly'); output.readOnly = true; output.rows = 6; output.hidden = true; output.setAttribute('aria-label', '署名した文書');
  const copy = make('button', '内容をコピー', 'head-action btn btn-secondary'); copy.type = 'button'; copy.hidden = true;
  const confirmHost = make('div');
  const notice = make('p', '', 'meta'); notice.setAttribute('role', 'status');

  const field = (labelText, placeholder) => {
    const label = make('label', undefined, 'settings-field');
    label.append(make('span', labelText));
    const input = make('input'); input.type = 'url'; input.placeholder = placeholder; input.maxLength = 2048; input.autocomplete = 'off';
    label.append(input);
    return [label, input];
  };
  const [oldLabel, oldInput] = field('今のアカウントのURL', 'https://旧ハブ/users/名前');
  const [newLabel, newInput] = field('引っ越し先のアカウントのURL', 'https://新ハブ/users/名前');
  const [regLabel, regInput] = field('鍵を登録するアカウントのURL', 'https://ハブ/users/名前');

  const moveButton = make('button', '引っ越し宣言を作る', 'btn btn-secondary'); moveButton.type = 'button';
  const regButton = make('button', '登録文を作る', 'btn btn-secondary'); regButton.type = 'button';

  function show(document_) {
    output.value = JSON.stringify(document_, null, 2);
    output.hidden = false; copy.hidden = false;
  }
  function fail(error) {
    const code = String(error?.message ?? error ?? '');
    notice.textContent = code.includes('portable_identity_unavailable')
      ? 'この端末の鍵がまだ用意できていません。「この端末」の節でPersonal Nodeを設定してから、もう一度お試しください。'
      : code.includes('invalid') ? 'URLの形が正しくありません。' : '署名できませんでした。';
  }
  moveButton.addEventListener('click', () => {
    notice.textContent = '';
    if (!validActorUrl(oldInput.value) || !validActorUrl(newInput.value) || oldInput.value.trim() === newInput.value.trim()) {
      notice.textContent = '2つのURLを、https:// で始まる別々のものとして入力してください。'; return;
    }
    confirmInline(document, confirmHost, {
      message: `「${oldInput.value.trim()}」から「${newInput.value.trim()}」への引っ越し宣言に、この端末の鍵で署名します。署名した文書は画面に表示するだけで、どこにも送りません。新しいハブへ渡すかどうかはご自身で決めます。`,
      yes: '署名する',
      onYes: async () => {
        try { show(await invoke('portable_identity_sign_move', { oldActor: oldInput.value.trim(), newActor: newInput.value.trim() })); notice.textContent = '署名しました。'; } catch (error) { fail(error); }
      },
    });
  });
  regButton.addEventListener('click', () => {
    notice.textContent = '';
    if (!validActorUrl(regInput.value)) { notice.textContent = 'https:// で始まるURLを入力してください。'; return; }
    confirmInline(document, confirmHost, {
      message: `この端末の公開鍵を「${regInput.value.trim()}」のアカウントの本人確認用の鍵として登録するための文書に署名します。署名した文書は画面に表示するだけで、どこにも送りません。`,
      yes: '署名する',
      onYes: async () => {
        try { show(await invoke('portable_identity_sign_registration', { actorUrl: regInput.value.trim() })); notice.textContent = '署名しました。'; } catch (error) { fail(error); }
      },
    });
  });
  copy.addEventListener('click', async () => {
    try { await globalThis.navigator.clipboard.writeText(output.value); notice.textContent = 'コピーしました。'; } catch { notice.textContent = 'コピーできませんでした。文字を選んでコピーしてください。'; }
  });

  const intro = make('p', 'ほかのハブへ引っ越しても同じ人だと示すための、署名だけに使う鍵です。ログインにも、ウォレットにも使いません。秘密鍵はこの端末の外へ出ず、書き出すことも取り込むこともできません。', 'subtle');
  element.append(
    intro, make('h4', '公開している鍵（did:key）', 'settings-sub'), did, state,
    make('h4', '別のハブへ引っ越す', 'settings-sub'), oldLabel, newLabel, make('div', undefined, 'actions'),
    make('h4', '鍵をアカウントに登録する', 'settings-sub'), regLabel, make('div', undefined, 'actions'),
    confirmHost, notice, output, copy,
  );
  const moveActions = element.querySelectorAll('.actions');
  moveActions[0].append(moveButton); moveActions[1].append(regButton);

  async function refresh() {
    try {
      const value = await invoke('portable_identity_public');
      did.value = typeof value?.didKey === 'string' ? value.didKey : '';
      state.textContent = did.value ? '' : '公開鍵を取得できませんでした。';
      moveButton.disabled = regButton.disabled = !did.value;
    } catch (error) {
      did.value = '';
      moveButton.disabled = regButton.disabled = true;
      state.textContent = 'この端末の鍵がまだ用意できていません。「この端末」の節でPersonal Nodeを設定すると表示されます。';
    }
  }
  return { element, refresh };
}

/** この端末のメディアキャッシュ（media_cache_usage / media_cache_clear）。 */
export function createCachePanel({ document, invoke }) {
  const make = builder(document);
  const element = make('div', undefined, 'card');
  const usage = make('p', '', 'meta'); usage.setAttribute('role', 'status');
  const confirmHost = make('div');
  const clear = make('button', 'キャッシュを消す', 'deny btn btn-ghost'); clear.type = 'button';
  element.append(settingHeader(document, { label: '保存した曲のデータ', desc: '消しても作品は失われません。', keywords: 'キャッシュ 容量 削除 消す' }),
    usage, make('div', undefined, 'actions'), confirmHost);
  element.querySelector('.actions').append(clear);
  async function refresh() {
    try {
      const value = await invoke('media_cache_usage');
      const bytes = Array.isArray(value) ? value[0] : NaN;
      const files = Array.isArray(value) ? value[1] : NaN;
      usage.textContent = Number.isFinite(bytes) ? `使用中: ${formatBytes(bytes)}（${Number.isFinite(files) ? files : '?'}件）` : '使用量を確認できません。';
    } catch { usage.textContent = '使用量を確認できません。'; }
  }
  clear.addEventListener('click', () => {
    confirmInline(document, confirmHost, {
      message: 'キャッシュを全部消します。元に戻せませんが、必要になった曲はまた取得されます。',
      yes: '消す',
      onYes: async () => { try { await invoke('media_cache_clear'); } catch { usage.textContent = '消せませんでした。'; return; } await refresh(); },
    });
  });
  return { element, refresh };
}

/** ブラウザ: 広告・トラッカーの保護だけが、設定として実際に読み書きできる。 */
export function createBrowserPanel({ document, invoke, storage = null, onWebSearchChange = null }) {
  const make = builder(document);
  const element = make('div', undefined, 'card');
  const toggle = make('input'); toggle.type = 'checkbox'; toggle.disabled = true;
  toggle.setAttribute('role', 'switch');
  const label = settingRow(document, { label: '広告と追跡を止める', desc: '反映は読み込み直したあと。', control: toggle, keywords: '広告 トラッカー ブロック 追跡 プライバシー' });
  const state = make('p', '', 'meta'); state.setAttribute('role', 'status');
  element.append(settingHeader(document, { label: 'アプリ内ブラウザ' }), label, state);
  const webSearch = createWebSearchSetting({ document, storage, onChange: (id) => onWebSearchChange?.(id) });
  element.append(webSearch.element);
  const valid = (v) => v && typeof v.supported === 'boolean' && typeof v.enabled === 'boolean' && typeof v.ready === 'boolean';
  function paint(v) {
    toggle.checked = v.enabled;
    toggle.disabled = !(v.supported && v.ready);
    state.textContent = !v.supported ? 'この環境では利用できません。' : !v.ready ? '保護の準備ができていません。' : '';
  }
  async function refresh() {
    try { const v = await invoke('browser_protection_status', {}); if (!valid(v)) throw Error('invalid'); paint(v); }
    catch { toggle.disabled = true; state.textContent = '状態を確認できません。'; }
  }
  toggle.addEventListener('change', async () => {
    const wanted = toggle.checked; toggle.disabled = true;
    try {
      const v = await invoke('browser_set_protection', { enabled: wanted });
      if (!valid(v) || v.enabled !== wanted) throw Error('unknown');
      paint(v);
    } catch { state.textContent = '変更の結果を確認できません。状態を読み直します。'; await refresh(); }
  });
  return { element, refresh };
}

/** このアプリについて: バージョン・接続先・ライセンス。更新の仕組みはアプリに無いので載せない。 */
export function createAboutPanel({ document, invoke, getVersion }) {
  const make = builder(document);
  const element = make('div', undefined, 'card');
  const list = make('dl', undefined, 'settings-about');
  const rows = new Map();
  for (const [key, term] of [['version', 'バージョン'], ['mode', '版の種類'], ['hub', '接続先のHub'], ['license', 'ライセンス']]) {
    const dt = make('dt', term), dd = make('dd', '確認中…');
    rows.set(key, dd); list.append(dt, dd);
  }
  rows.get('license').textContent = 'AGPL-3.0（ハブ本体）';
  element.append(settingHeader(document, { label: 'このアプリについて', keywords: 'バージョン ライセンス 更新 ビルド' }), list,
    make('p', '自動更新はありません。入れ直して更新します。', 'meta'));
  async function refresh() {
    const set = (key, text) => { rows.get(key).textContent = text; };
    try { set('version', String(await getVersion())); } catch { set('version', '不明'); }
    try { set('mode', (await invoke('desktop_build_mode')) === 'development' ? '開発版' : 'ローカル'); } catch { set('mode', '不明'); }
    try { set('hub', new URL(await invoke('hub_origin')).host); } catch { set('hub', '不明'); }
  }
  return { element, refresh };
}

/**
 * 保存容量のメーター（hub_client storage）。合計の正本は Account で、読めないときは 0 と出さず「読み込めません」と出す。
 * プランの購入は Hub の設定の保存容量で行う（この画面は表示と、そこへの入口だけ）。
 */
/** 次の更新時刻（日本時間）。 */
export function formatRenewalDate(ms) {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}

export function createStoragePanel({ document, invoke, openExternal }) {
  const make = builder(document);
  const element = make('div', undefined, 'card');
  const state = make('p', '', 'meta'); state.setAttribute('role', 'status');
  const meter = make('div', undefined, 'storage-meter'); meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-label', '共通ストレージ使用率'); meter.hidden = true;
  const fill = make('i'); meter.append(fill);
  const banner = make('p', '', 'meta'); banner.setAttribute('role', 'status'); banner.hidden = true;
  // 自動更新は方式と次の更新時刻の表示だけ。申込み・取り消しは Web の画面で行う（AUTOPAY.md §6.4）。
  const renewal = make('p', '', 'meta'); renewal.setAttribute('role', 'status'); renewal.hidden = true;
  const actions = make('div', undefined, 'actions');
  const open = make('button', '容量を増やす・自動更新の設定（Hubで開く）', 'btn btn-secondary'); open.type = 'button';
  actions.append(open);
  element.append(settingHeader(document, { label: '保存容量', desc: '画像・音楽・動画・ファイルで共有する容量です。上限を超えても、ファイルは消えません。新しいアップロードだけが止まります。', keywords: '容量 ストレージ プラン 購入 上限 保存容量' }),
    state, meter, banner, renewal, actions);
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  function fail() {
    meter.hidden = true; banner.hidden = true; renewal.hidden = true;
    state.textContent = '読み込めません';
  }
  async function refresh() {
    let value;
    try { value = await invoke('hub_client', { name: 'storage' }); } catch { fail(); return; }
    const limit = count(value?.limitBytes), used = count(value?.usedBytes);
    if (typeof value?.planCode !== 'string' || limit === null || used === null || limit <= 0) { fail(); return; }
    const ratio = used / limit;
    const percent = Math.min(100, Math.round(ratio * 100));
    const level = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'near' : 'normal';
    const plan = value.planCode === 'free' ? '無料' : `プラン ${value.planCode}`;
    state.textContent = `${plan}: ${formatBytes(used)} / ${formatBytes(limit)}（${percent}%）`;
    meter.hidden = false; meter.dataset.level = level;
    meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', String(percent));
    fill.style.width = `${percent}%`;
    banner.hidden = level === 'normal';
    banner.dataset.level = level;
    renewal.hidden = true;
    if (value.renewal === 'auto') {
      const next = Date.parse(value.nextRenewalAt);
      renewal.textContent = Number.isFinite(next) ? `自動更新: 有効 ・ 次の更新 ${formatRenewalDate(next)}` : '自動更新: 有効';
      renewal.hidden = false;
    } else if (value.renewal === 'manual' && value.planCode !== 'free') {
      renewal.textContent = '自動更新: オフ（手動で更新）';
      renewal.hidden = false;
    }
    banner.textContent = level === 'full' ? '容量の上限に達しています。新しいアップロードは止まっています。ファイルは消えません。' : '容量が上限の80%に達しました。';
  }
  open.addEventListener('click', async () => {
    try { await openExternal(`${new URL(await invoke('hub_origin')).origin}/v2/settings#v2-settings-storage`); } catch { state.textContent = 'Hubを開けませんでした。'; }
  });
  state.textContent = '確認中…';
  return { element, refresh };
}
