import { attachAddressSelectAll } from './address-select-all.mjs';
import { navigationTarget } from './browser-navigation.mjs';

/*
 * 右列ブラウザ（2026-10-15）。右列だけでスマホのブラウザのように動く専用の子webview。
 * ページ本体は Rust 側（browser_rail.rs）。ここは操作列・位置の通知・記憶・中央との行き来だけを持つ。
 * 外部ページには何も渡さない。渡すのは http/https のURLと、右列の枠の寸法だけ。
 */

export const RAIL_URL_KEY = 'hub.desktop.railBrowserUrl';
const MAX_URL = 2048;

/** http/https だけ。資格情報つき・アプリ自身のオリジン・長すぎるものは null。 */
export function railUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hostname === 'tauri.localhost') return null;
    return url.href;
  } catch { return null; }
}

/** 上の欄に打った文字を、開くURLにする（住所はそのまま、それ以外は検索）。 */
export function railTarget(text, engine = 'google') {
  try { return railUrl(navigationTarget(text, engine)); } catch { return null; }
}

/** 欄に出す短い形。スキームと末尾のスラッシュを省く。 */
export function displayAddress(raw) {
  const href = railUrl(raw);
  if (!href) return '';
  const url = new URL(href);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
}

const CENTER_VIEWS = Object.freeze({
  '': { view: 'feed', title: 'フィード' }, '/': { view: 'feed', title: 'フィード' }, '/feed': { view: 'feed', title: 'フィード' },
  '/music': { view: 'music', title: '音楽' }, '/videos': { view: 'videos', title: '動画' }, '/articles': { view: 'articles', title: '記事' },
  '/messages': { view: 'messages', title: 'メッセージ' }, '/notifications': { view: 'notifications', title: '通知' },
  '/ai': { view: 'ai', title: 'AI' }, '/search': { view: 'search', title: '検索' }, '/community': { view: 'community', title: 'コミュニティ' },
  '/market': { view: 'market', title: 'マーケット' }, '/shopping': { view: 'market', title: 'マーケット' },
  '/wallet': { view: 'wallet', title: 'ウォレット' }, '/hubpedia': { view: 'hubpedia', title: 'Hubpedia' },
});

/**
 * 「中央で開く」の行き先。Hub の画面でアプリに同じ画面があれば中央のその画面、
 * 同じ画面が無い Hub のページは断る（2026-10-15 所有者決定：Hub はデスクトップのブラウザに出さない。
 * OS の既定ブラウザへ黙って回さない）、外部サイトは中央のブラウザのタブ。
 */
export function centerRoute(raw, hubHosts = []) {
  const href = railUrl(raw);
  if (!href) return null;
  const url = new URL(href);
  if (!hubHosts.includes(url.host)) return { kind: 'tab', url: href };
  const path = url.pathname.replace(/\/+$/u, '');
  const view = Object.hasOwn(CENTER_VIEWS, path) ? CENTER_VIEWS[path] : null;
  return view ? { kind: 'view', ...view } : { kind: 'refused' };
}

const EMPTY = Object.freeze({ url: '', title: '', loading: false, canBack: false, canForward: false, playingAudio: false, ready: false });

/** Rust から届いた様子を検めて、画面に使う形にする。形が違えば捨てる。 */
export function normalizeInfo(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const text = (value) => typeof value === 'string' ? value.slice(0, 2048) : null;
  const flag = (value) => typeof value === 'boolean' ? value : null;
  const out = { url: text(payload.url), title: text(payload.title), loading: flag(payload.loading), canBack: flag(payload.canBack), canForward: flag(payload.canForward), playingAudio: flag(payload.playingAudio), ready: flag(payload.ready) };
  return Object.values(out).some((value) => value === null) ? null : out;
}

/** 操作列の状態。ページを開く前は戻る・進む・再読み込み・中央で開くが使えない。 */
export function toolbarState(info) {
  const url = railUrl(info.url);
  return {
    back: info.ready && info.canBack,
    forward: info.ready && info.canForward,
    reload: info.ready,
    center: Boolean(info.ready && url),
    reloadMode: info.loading ? 'stop' : 'reload',
    address: displayAddress(info.url),
    title: info.title || '',
  };
}

const RELOAD_ICON = 'M19 12a7 7 0 1 1-2.1-5M19 4v4h-4';
const STOP_ICON = 'm6 6 12 12M18 6 6 18';

export function createRailBrowser({
  document, window, invoke, listen, storage = null, getHubOrigin, getEngine = () => 'google',
  isShown, reveal, openCenterView, openCenterTab, openExternal, pauseCentre, notice = () => {},
}) {
  const $ = (id) => document.getElementById(id);
  const stage = $('rail-browser-stage'), address = $('rb-address'), form = $('rb-form'), note = $('rb-note');
  const buttons = { back: $('rb-back'), forward: $('rb-forward'), reload: $('rb-reload'), center: $('rb-center') };
  if (!stage || !address || !form || Object.values(buttons).some((button) => !button)) return null;
  attachAddressSelectAll(address);
  let info = { ...EMPTY };
  let started = false, pendingUrl = null, lastKey = null, frame = null, busy = false, dirty = false, hubHosts = null;

  const read = () => { try { return storage?.getItem(RAIL_URL_KEY) ?? null; } catch { return null; } };
  const write = (url) => { try { storage?.setItem(RAIL_URL_KEY, url); } catch { /* 記憶できなくても動く */ } };
  async function hosts() {
    if (hubHosts) return hubHosts;
    const list = new Set(['hub.jkamma.com']);
    try { list.add(new URL(await getHubOrigin()).host); } catch { /* Hub のオリジンが取れなくても既定の本番は判定できる */ }
    return (hubHosts = [...list]);
  }
  const isHub = async (raw) => { const href = railUrl(raw); return Boolean(href) && (await hosts()).includes(new URL(href).host); };

  function measure() {
    if (!isShown() || document.querySelector('dialog[open]') || document.body.classList.contains('column-resizing') || document.visibilityState === 'hidden') return null;
    const rect = stage.getBoundingClientRect();
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every(Number.isFinite) || !(window.innerWidth > 0) || !(window.innerHeight > 0)) return null;
    // 枠が窓より大きい（低い窓）ときは、見えている分に切り詰める。断ると右列のブラウザが一度も始まらない。
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
    const w = right - left, h = bottom - top;
    if (w < 120 || h < 80) return null;
    return { x: left, y: top, w, h };
  }
  let noteTimer = null;
  function showNote(text) { note.textContent = text ?? ''; note.hidden = !text; }
  // 右列が見えているときは右列の中に短く出す（全画面の「お知らせ」は使わない）。見えていないときだけ共通の通知へ。
  function say(text) {
    if (!isShown()) { notice(text); return; }
    showNote(text); window.clearTimeout(noteTimer); noteTimer = window.setTimeout(() => showNote(''), 6000);
  }

  // アプリの配色（ダーク既定）を右列のページへ伝える。OSの設定ではなく、この右列だけが従う。
  let lastDark = null;
  function syncScheme() {
    const dark = document.documentElement.dataset.theme !== 'light';
    if (dark === lastDark) return;
    lastDark = dark;
    void invoke('rail_browser_scheme', { dark }).catch(() => { lastDark = null; });
  }

  async function start(rect) {
    started = true;
    syncScheme();
    // 起点は覚えている外部ページ、無ければブラウザ自身の新規タブ画面（Hub は出さない）。
    let url = pendingUrl ?? railUrl(read());
    if (url && await isHub(url)) url = null;
    pendingUrl = null;
    try { await invoke('rail_browser_open', { url }); showNote(''); }
    catch { started = false; showNote('右列のブラウザを開けませんでした。もう一度試します。'); if (rect) window.setTimeout(schedule, 2000); }
  }
  async function flush() {
    if (busy || !dirty) return;
    dirty = false; busy = true;
    try {
      const rect = measure();
      const key = JSON.stringify(rect);
      if (key !== lastKey) { await invoke('rail_browser_layout', { rect, visible: Boolean(rect) }); lastKey = key; }
      if (rect && !started) await start(rect);
    } catch { lastKey = null; }
    finally { busy = false; if (dirty) schedule(); }
  }
  function schedule() {
    dirty = true;
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => { frame = null; void flush(); });
  }

  function paint() {
    const state = toolbarState(info);
    buttons.back.disabled = !state.back; buttons.forward.disabled = !state.forward; buttons.reload.disabled = !state.reload; buttons.center.disabled = !state.center;
    const stopping = state.reloadMode === 'stop';
    buttons.reload.setAttribute('aria-label', stopping ? '読み込みを止める' : '再読み込み');
    buttons.reload.title = stopping ? '読み込みを止める' : '再読み込み';
    buttons.reload.dataset.mode = state.reloadMode;
    buttons.reload.querySelector('path')?.setAttribute('d', stopping ? STOP_ICON : RELOAD_ICON);
    if (document.activeElement !== address) address.value = state.address;
    $('rb-title').textContent = state.title;
    address.title = state.title || '';
  }
  function apply(payload) {
    const next = normalizeInfo(payload);
    if (!next) return;
    const wasPlaying = info.playingAudio;
    info = next;
    const url = railUrl(next.url);
    if (url) write(url);
    paint();
    if (next.playingAudio && !wasPlaying) pauseCentre();
  }

  async function openInRail(raw) {
    const url = railUrl(raw);
    if (!url) { say('このアドレスは右列で開けません。'); return false; }
    // Hub のアドレスは右列では開かず、中央の同じ画面へ（無ければ断る）。
    if (await isHub(url)) return centerOpen(url);
    pendingUrl = url;
    reveal();
    if (started) {
      pendingUrl = null;
      try { await invoke('rail_browser_open', { url }); } catch { say('右列のブラウザで開けませんでした。'); return false; }
    } else schedule();
    return true;
  }
  async function centerOpen(raw = info.url) {
    const route = centerRoute(raw, await hosts());
    if (!route) return false;
    if (route.kind === 'view') openCenterView(route.view, route.title);
    else if (route.kind === 'tab') openCenterTab(route.url);
    else { say('Hubの画面はブラウザでは開きません。中央のHubの画面から開いてください。'); return false; }
    return true;
  }

  const run = (name) => () => { void invoke(name).catch(() => say('右列のブラウザを操作できませんでした。')); };
  buttons.back.addEventListener('click', run('rail_browser_back'));
  buttons.forward.addEventListener('click', run('rail_browser_forward'));
  buttons.reload.addEventListener('click', () => { if (buttons.reload.dataset.mode === 'stop') run('rail_browser_stop')(); else run('rail_browser_reload')(); });
  buttons.center.addEventListener('click', () => { void centerOpen(); });
  address.addEventListener('focus', () => { const url = railUrl(info.url); if (url) address.value = url; address.select(); });
  address.addEventListener('blur', () => paint());
  address.addEventListener('keydown', (event) => { if (event.key === 'Escape') { paint(); address.blur(); } });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = railTarget(address.value, getEngine());
    if (!url) { say('開けるアドレスか、検索する言葉を入力してください。'); return; }
    address.blur();
    void openInRail(url);
  });

  new window.MutationObserver(syncScheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new window.ResizeObserver(schedule).observe(stage);
  const shell = document.querySelector('.app-shell');
  if (shell) new window.MutationObserver(schedule).observe(shell, { attributes: true, attributeFilter: ['class', 'hidden'] });
  new window.MutationObserver(schedule).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'class'] });
  for (const event of ['resize', 'focus', 'blur']) window.addEventListener(event, schedule);
  document.addEventListener('visibilitychange', schedule);

  if (typeof listen === 'function') {
    void Promise.all([
      listen('rail-browser-state', (event) => apply(event.payload)),
      listen('rail-browser-open-request', (event) => void openInRail(event.payload?.url)),
      listen('rail-browser-open-center', (event) => void centerOpen(event.payload?.url)),
    ]).catch(() => {});
  }
  paint();
  schedule();
  return {
    schedule, openInRail, centerOpen, apply,
    /** 中央のプレーヤーが鳴り始めた。右列のページの再生を止める。 */
    pauseRail: () => { if (started) void invoke('rail_browser_pause_media').catch(() => {}); },
    state: () => ({ ...info, started }),
  };
}
