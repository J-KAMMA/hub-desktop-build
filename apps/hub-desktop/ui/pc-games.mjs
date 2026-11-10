// この PC のゲーム（2026-11-06）。Steam と Epic が端末に置いた記録を読むだけの一覧。端末の外へ出さない。
// 起動はランチャーのプロトコル、「並べる」はゲーム窓を中央の領域に重ねて右のレールを残す（src-tauri/src/game_dock.rs）。
// 画面が Rust へ渡すのは一覧で返した id だけ。パスや URL は渡さない。
import { gameInitial } from './games-tiles.mjs';
import { dataImageToBlobUrl } from './blob-image.mjs';

const SOURCE_NAMES = { steam: 'Steam', epic: 'Epic' };

// 文言：状態は短く。キーは Rust の Note と同じ名前。
export const DOCK_NOTES = {
  timeout: 'ゲームの窓が見つかりませんでした',
  exclusive: '全画面専用のため並べられません',
  refused: 'この窓は大きさを変えられません',
  gone: 'ゲームが終了しました',
  hub_closed: '',
};

const ICONS = {
  play: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  dock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M7 10l3 2-3 2"/></svg>',
  refresh: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.1-5M19 4v4h-4"/></svg>',
  stop: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  close: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(document, className, icon, label, onClick, text) {
  const button = el(document, 'button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = icon; // 固定の SVG だけ
  if (text) button.append(el(document, 'span', 'pcg-btn-text', text));
  button.onclick = onClick;
  return button;
}

/** API 応答を表示用に絞る。 */
export function normalizeLibrary(data) {
  const rows = Array.isArray(data?.games) ? data.games : [];
  const games = rows
    .filter((row) => row && typeof row.id === 'string' && /^(steam|epic):/.test(row.id) && typeof row.name === 'string' && row.name)
    .map((row) => ({ id: row.id, source: row.source === 'epic' ? 'epic' : 'steam', name: row.name }));
  const notes = Array.isArray(data?.notes) ? data.notes.filter((n) => typeof n === 'string') : [];
  return { games, notes };
}

function artImage(document, url) {
  const img = el(document, 'img');
  img.alt = '';
  const blobUrl = dataImageToBlobUrl(url, { maxBytes: 2 * 1024 * 1024 });
  if (!blobUrl) return null;
  img.src = blobUrl;
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

/**
 * host：一覧の置き場。bar：右のレールの上の状態と「並べるのをやめる」。
 * deps：list() / art(id) / launch(id) / dockStart(id, rect, dpr) / dockRect(rect, dpr) / dockStop() /
 *       measure() => { rect:{x,y,w,h}, dpr } / ensureRail?() / nextFrame?() / friendlyError?(e) / notify?(text)
 */
export function createPcGames({ document, host, bar, deps }) {
  const state = {
    status: 'idle', games: [], notes: [], message: '', art: new Map(), artQueue: [], artBusy: false, request: 0,
    dock: { state: 'off', id: '', note: '' }, busyId: '',
  };
  const say = (error, fallback) => (deps.friendlyError ? deps.friendlyError(error) : fallback);

  function renderTile(game) {
    const tile = el(document, 'div', 'pcg-tile');
    tile.dataset.pcgId = game.id;
    const art = el(document, 'div', 'pcg-art');
    art.append(el(document, 'span', 'pcg-letter', gameInitial(game.name)));
    const url = state.art.get(game.id);
    if (url) art.append(artImage(document, url));
    const body = el(document, 'div', 'pcg-body');
    body.append(el(document, 'strong', 'pcg-name', game.name), el(document, 'span', 'pcg-source', SOURCE_NAMES[game.source] ?? ''));
    const actions = el(document, 'div', 'pcg-actions');
    const launch = iconButton(document, 'pcg-btn', ICONS.play, '起動', () => void api.launch(game.id));
    const dock = iconButton(document, 'pcg-btn', ICONS.dock, '右のレールの隣に並べて起動', () => void api.dock(game.id));
    launch.disabled = dock.disabled = state.busyId === game.id;
    launch.dataset.pcgLaunch = '';
    dock.dataset.pcgDock = '';
    actions.append(launch, dock);
    tile.append(art, body, actions);
    return tile;
  }

  function render() {
    const head = el(document, 'div', 'pcg-head');
    head.append(el(document, 'h3', 'pcg-title', 'この PC のゲーム'), iconButton(document, 'pcg-btn pcg-refresh', ICONS.refresh, '読み直す', () => void api.load()));
    const children = [head];
    if (state.status === 'loading' || state.status === 'idle') {
      const skeleton = el(document, 'div', 'pcg-grid');
      skeleton.setAttribute('aria-busy', 'true');
      for (let i = 0; i < 4; i += 1) skeleton.append(el(document, 'div', 'pcg-skeleton'));
      children.push(skeleton);
    } else if (state.status === 'error') {
      children.push(el(document, 'p', 'pcg-empty', state.message || '読み込めませんでした'));
    } else if (!state.games.length) {
      children.push(el(document, 'p', 'pcg-empty', '見つかりません'));
    } else {
      const grid = el(document, 'div', 'pcg-grid');
      grid.append(...state.games.map(renderTile));
      children.push(grid);
    }
    if (state.status === 'ready' && state.notes.includes('xbox_not_supported')) children.push(el(document, 'p', 'pcg-note', 'Xbox のゲームは表示されません'));
    host.replaceChildren(...children);
    renderBar();
  }

  function renderBar() {
    if (!bar) return;
    const { state: mode, note } = state.dock;
    bar.dataset.state = mode;
    if (mode === 'off') { bar.hidden = true; bar.replaceChildren(); return; }
    const text = mode === 'searching' ? 'ゲームの窓を探しています' : mode === 'docked' ? '並べています' : (DOCK_NOTES[note] ?? '');
    if (mode === 'stopped' && !text) { bar.hidden = true; bar.replaceChildren(); return; }
    bar.hidden = false;
    const label = el(document, 'span', 'pcg-dock-text', text);
    bar.replaceChildren(label, mode === 'stopped'
      ? iconButton(document, 'pcg-btn pcg-dock-close', ICONS.close, '閉じる', () => api.dismiss())
      : iconButton(document, 'pcg-btn pcg-dock-stop', ICONS.stop, '並べるのをやめる', () => void api.stopDock(), '並べるのをやめる'));
  }

  async function pumpArt() {
    if (state.artBusy) return;
    state.artBusy = true;
    const request = state.request;
    while (state.artQueue.length && request === state.request) {
      const id = state.artQueue.shift();
      try {
        const url = await deps.art(id);
        if (request !== state.request) break;
        if (typeof url === 'string' && url.startsWith('data:image/')) {
          state.art.set(id, url);
          const tile = [...host.querySelectorAll('[data-pcg-id]')].find((node) => node.dataset.pcgId === id);
          const art = tile?.querySelector('.pcg-art');
          const image = art && !art.querySelector('img') ? artImage(document, url) : null;
          if (image) art.append(image);
        }
      } catch { /* 絵が無いのは文字のタイルで足りる */ }
    }
    state.artBusy = false;
  }

  const api = {
    render,
    state: () => state,
    async load() {
      const request = ++state.request;
      state.status = 'loading';
      render();
      try {
        const data = normalizeLibrary(await deps.list());
        if (request !== state.request) return;
        state.status = 'ready';
        state.games = data.games;
        state.notes = data.notes;
        state.artQueue = data.games.filter((g) => g.source === 'steam' && !state.art.has(g.id)).map((g) => g.id);
        render();
        void pumpArt();
      } catch (error) {
        if (request !== state.request) return;
        state.status = 'error';
        state.message = say(error, '読み込めませんでした');
        render();
      }
    },
    async launch(id) {
      if (state.busyId) return;
      state.busyId = id;
      render();
      try { await deps.launch(id); }
      catch (error) { deps.notify?.(say(error, '起動できませんでした')); }
      finally { state.busyId = ''; render(); }
    },
    /** 起動して、そのゲームの窓を中央の領域へ重ねる。右のレールを開いてから測る。 */
    async dock(id) {
      if (state.busyId) return;
      state.busyId = id;
      render();
      try {
        deps.ensureRail?.();
        await (deps.nextFrame ? deps.nextFrame() : Promise.resolve());
        const { rect, dpr } = deps.measure();
        state.dock = { state: 'searching', id, note: '' };
        renderBar();
        await deps.dockStart(id, rect, dpr);
      } catch (error) {
        state.dock = { state: 'off', id: '', note: '' };
        deps.notify?.(say(error, '並べられませんでした'));
      } finally { state.busyId = ''; render(); }
    },
    async stopDock() {
      state.dock = { state: 'off', id: '', note: '' };
      renderBar();
      try { await deps.dockStop(); } catch { /* 既に止まっている */ }
    },
    dismiss() { state.dock = { state: 'off', id: '', note: '' }; renderBar(); },
    /** Rust の pc-game-dock イベント。 */
    setDock(payload) {
      const mode = payload?.state;
      if (!['searching', 'docked', 'stopped'].includes(mode)) return;
      if (state.dock.state === 'off') return; // 画面が止めた後に遅れて届いたイベント
      state.dock = { state: mode, id: state.dock.id, note: typeof payload.note === 'string' ? payload.note : '' };
      renderBar();
    },
    /** 中央の領域が変わったとき。並べている間だけ Rust へ送る。 */
    syncRect() {
      if (state.dock.state !== 'searching' && state.dock.state !== 'docked') return;
      try { const { rect, dpr } = deps.measure(); void Promise.resolve(deps.dockRect(rect, dpr)).catch(() => {}); } catch { /* 測れないときは送らない */ }
    },
  };
  return api;
}
