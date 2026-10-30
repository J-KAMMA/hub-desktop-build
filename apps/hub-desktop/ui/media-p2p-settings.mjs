import { settingRow, settingHeader } from './settings-view.mjs';

// 音楽のP2P配布の設定（DESIGN 6.3）。受け取りと配布は別々の任意参加で、どちらも既定はオフ。
// 保存はRust側（media_p2p_settings_get / media_p2p_settings_set）。このモジュールは表示と同意だけを持つ。
// 有効にする前に、IPアドレスが見えることを平文で示し、明示の確認を取る。

// 法務確認待ち（DESIGN 11章）: 次の告知文は法務の確認が終わるまで暫定。確認後に利用規約と同じ文へ揃える。
export const MEDIA_P2P_NOTICE = {
  common: 'この機能を有効にすると、接続する相手の端末、中継サービスの運営者、およびMedia Tracker（相手を探す案内サービス）に、この端末のIPアドレスが見えます。',
  receive: '他の端末から受け取る: 配っている端末にこの端末のIPアドレスが見えます。「中継のみで接続する」をオンにすると相手には見えませんが、中継の運営者には見えます。',
  seed: 'この端末から配る: 再生したHubのオリジナル曲を、他の端末へ配ります。配っている間、相手とHubの中継サービスにこの端末のIPアドレスが見えます。作成者が公開をやめた曲は自動で配布をやめて削除します。アプリを閉じると配布も止まります。',
};

// 設定コマンドの呼び出しは、この2関数に集める（引数の形が変わった時はここだけ直す）。
// Rust 側の形（media_cache.rs の MediaP2pSettings、camelCase）と画面の形を、ここで相互に移す。
// 保存は Rust が欠けた項目を既定値で埋めるので、必ず今の設定全体に差分を重ねて送る。
const MIB = 1024 * 1024;
const toView = (raw, usage) => ({
  receive: raw?.receiveFromPeers === true, seed: raw?.seed === true, relayOnly: raw?.relayOnly === true,
  quotaBytes: Number.isSafeInteger(raw?.cacheLimitMib) ? raw.cacheLimitMib * MIB : 0,
  usedBytes: Array.isArray(usage) && Number.isSafeInteger(usage[0]) ? usage[0] : 0,
  seedingTracks: 0, sentBytes: 0,
});
const readUsage = (invoke) => Promise.resolve(invoke('media_cache_usage')).catch(() => null);
const readSettings = async (invoke) => { const [raw, usage] = await Promise.all([invoke('media_p2p_settings_get'), readUsage(invoke)]); return toView(raw, usage); };
const writeSettings = async (invoke, patch) => {
  const current = await invoke('media_p2p_settings_get');
  const next = { ...current };
  if (typeof patch?.receive === 'boolean') next.receiveFromPeers = patch.receive;
  if (typeof patch?.seed === 'boolean') next.seed = patch.seed;
  if (typeof patch?.relayOnly === 'boolean') next.relayOnly = patch.relayOnly;
  const [saved, usage] = await Promise.all([invoke('media_p2p_settings_set', { settings: next }), readUsage(invoke)]);
  return toView(saved, usage);
};

const bool = (value) => value === true;
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function normalizeMediaP2pSettings(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    receive: bool(value.receive),
    seed: bool(value.seed),
    relayOnly: bool(value.relayOnly),
    quotaBytes: count(value.quotaBytes),
    usedBytes: count(value.usedBytes),
    seedingTracks: count(value.seedingTracks),
    sentBytes: count(value.sentBytes),
  };
}

export function formatBytes(bytes) {
  const n = count(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = n / 1024, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size >= 10 ? Math.round(size) : Math.round(size * 10) / 10} ${units[unit]}`;
}

const LABELS = {
  receive: ['他の端末から受け取る', 'ほかの人の端末から、公開された曲を直接受け取ります。'],
  seed: ['他の端末へ配る', '再生したHub公開のオリジナル曲を、ほかの人の端末へ渡します。アプリを閉じると止まります。'],
  relayOnly: ['中継だけで接続する', '相手の端末にIPアドレスを見せません。中継サービスには見えます。'],
};
const KEYWORDS = 'P2P 配布 共有 シード 受け取り IPアドレス 中継 TURN 音楽 曲';

export function createMediaP2pSettings({ document, invoke, isCurrent = () => true }) {
  if (!document || typeof invoke !== 'function' || typeof isCurrent !== 'function') throw Error('media_p2p_host_invalid');
  const make = (tag, text, className = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const element = make('div', undefined, 'card media-p2p-settings');
  element.append(settingHeader(document, { label: '曲を端末どうしで受け渡す（任意）', desc: '2つともオフなら、この端末はほかの端末にも案内サービスにも接続しません。', keywords: KEYWORDS, key: 'media-p2p' }));
  const status = make('p', '', 'meta');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const boxes = {};
  const rows = make('div', undefined, 'settings-rows');
  for (const key of ['receive', 'seed', 'relayOnly']) {
    const box = make('input');
    box.type = 'checkbox';
    box.dataset.mediaP2p = key;
    boxes[key] = box;
    rows.append(settingRow(document, { label: LABELS[key][0], desc: LABELS[key][1], control: box, keywords: KEYWORDS, key: 'media-p2p-' + key }));
  }

  const notice = make('section', undefined, 'media-p2p-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'alertdialog');
  notice.setAttribute('aria-label', 'IPアドレスの公開に関する確認');
  const noticeText = make('div', undefined, 'meta');
  const confirm = make('button', '理解して有効にする', 'btn btn-secondary');
  confirm.type = 'button';
  confirm.dataset.mediaP2pAction = 'confirm';
  const cancel = make('button', 'キャンセル', 'head-action btn btn-secondary');
  cancel.type = 'button';
  cancel.dataset.mediaP2pAction = 'cancel';
  const noticeActions = make('div', undefined, 'actions');
  noticeActions.append(confirm, cancel);
  notice.append(noticeText, noticeActions);

  const quota = make('div', undefined, 'media-p2p-quota');
  const quotaText = make('p', '', 'meta');
  const quotaBar = make('progress');
  quotaBar.max = 100;
  quotaBar.value = 0;
  quotaBar.setAttribute('aria-label', 'キャッシュの使用量');
  const activity = make('p', '', 'meta');
  quota.append(quotaText, quotaBar, activity);

  element.append(rows, notice, quota, status);

  let state = normalizeMediaP2pSettings(null);
  let available = false, busy = false, pending = null, destroyed = false, turn = 0;
  const current = () => {
    try { return !destroyed && isCurrent() === true; } catch { return false; }
  };

  function paint() {
    for (const key of Object.keys(boxes)) {
      boxes[key].checked = state[key];
      boxes[key].disabled = !available || busy || pending !== null;
    }
    notice.hidden = pending === null;
    quotaText.textContent = state.quotaBytes
      ? `保存した曲のデータ: ${formatBytes(state.usedBytes)} / ${formatBytes(state.quotaBytes)}`
      : '保存した曲のデータ: 使用量を取得できません';
    quotaBar.value = state.quotaBytes ? Math.min(100, Math.round((state.usedBytes / state.quotaBytes) * 100)) : 0;
    activity.textContent = `配布中の曲: ${state.seedingTracks}曲 / 送った量: ${formatBytes(state.sentBytes)}（この端末の中だけで数え、どこにも送りません）`;
    element.setAttribute('aria-busy', String(busy));
  }

  async function apply(patch) {
    const mine = ++turn;
    busy = true;
    paint();
    try {
      const saved = await writeSettings(invoke, patch);
      if (!current() || mine !== turn) return false;
      state = normalizeMediaP2pSettings(saved && typeof saved === 'object' ? { ...state, ...saved } : { ...state, ...patch });
      status.textContent = '保存しました。';
      return true;
    } catch {
      if (current() && mine === turn) status.textContent = '設定を保存できませんでした。変更は反映されていません。';
      return false;
    } finally {
      if (mine === turn) { busy = false; if (current()) paint(); }
    }
  }

  async function refresh() {
    const mine = ++turn;
    busy = true;
    paint();
    try {
      const raw = await readSettings(invoke);
      if (!current() || mine !== turn) return;
      state = normalizeMediaP2pSettings(raw);
      available = true;
      status.textContent = '';
    } catch {
      if (!current() || mine !== turn) return;
      available = false;
      state = normalizeMediaP2pSettings(null);
      status.textContent = 'この版では設定を読み込めません。P2Pは使われません。';
    } finally {
      if (mine === turn) { busy = false; if (current()) paint(); }
    }
  }

  for (const key of Object.keys(boxes)) {
    boxes[key].addEventListener('change', () => {
      if (!available || busy || pending !== null || !current()) { paint(); return; }
      const wantOn = boxes[key].checked;
      // 受け取り・配布をオンにする時だけ、同意の確認を挟む。オフにする・中継のみは確認なしで即時。
      if (wantOn && (key === 'receive' || key === 'seed')) {
        pending = key;
        noticeText.replaceChildren(make('p', MEDIA_P2P_NOTICE.common), make('p', MEDIA_P2P_NOTICE[key]));
        boxes[key].checked = false;
        paint();
        return;
      }
      void apply({ [key]: wantOn });
    });
  }
  confirm.addEventListener('click', () => {
    if (pending === null || busy || !current()) return;
    const key = pending;
    pending = null;
    void apply({ [key]: true });
  });
  cancel.addEventListener('click', () => {
    if (pending === null) return;
    pending = null;
    status.textContent = '';
    paint();
  });

  paint();
  return {
    element,
    refresh,
    destroy() { destroyed = true; turn++; element.remove(); },
  };
}
