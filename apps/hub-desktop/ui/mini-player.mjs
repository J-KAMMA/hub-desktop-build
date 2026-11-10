// 画面の中に浮く小窓の再生（Hub の曲）。右列とは独立で、何かが鳴っている間は出る。
// YouTube の埋め込みは yt-dock.mjs の枠がそのまま小窓になる（iframe は一度作ったら動かさない）。
// この小窓は音声エンジンの操作盤だけを持つ。エンジンは app.js が渡す（前後・再生・位置・閉じる・元の画面）。
import { CORNER_KEY, readCorner, writeCorner, nearestCorner, cornerInsets, clampInsets, stackedBottom } from './mini-snap.mjs';

export { CORNER_KEY };
const W = 320;
const ICONS = {
  prev: '<path d="M7 6v12M18 6l-8 6 8 6z"/>',
  next: '<path d="M17 6v12M6 6l8 6-8 6z"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13"/>',
  expand: '<path d="M14 4h6v6M20 4l-8 8M10 20H4v-6"/>',
  queue: '<path d="M4 7h12M4 12h12M4 17h8M18 15v5M15.5 17.5 18 15l2.5 2.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const icon = (document, name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
};
const clock = seconds => { const t = Math.max(0, Math.round(Number(seconds) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

/**
 * engine: { state(): {track,paused,currentTime,duration,hasPrev,hasNext}, subscribe(fn)->off, toggle, prev, next, seek(s), close, expand }
 * dock: yt-dock の返り値（任意）。YouTube の小窓が出ているときは、重ならないよう寄せる。
 */
export function createMiniPlayer({ document, engine, dock = null, storage = null } = {}) {
  const window = document.defaultView;
  const host = document.createElement('div');
  host.id = 'mini-player'; host.className = 'mini-player'; host.hidden = true;
  host.setAttribute('role', 'region'); host.setAttribute('aria-label', '小窓の再生');
  const button = (name, label, onClick) => {
    const el = document.createElement('button'); el.type = 'button'; el.className = `mini-btn mini-${name}`; el.setAttribute('aria-label', label); el.title = label;
    el.append(icon(document, name)); el.addEventListener('click', onClick); return el;
  };
  const art = document.createElement('span'); art.className = 'mini-art'; art.setAttribute('aria-hidden', 'true');
  const artLetter = document.createElement('span'); art.append(artLetter);
  const artImg = document.createElement('img'); artImg.alt = ''; artImg.hidden = true; art.append(artImg);
  const text = document.createElement('span'); text.className = 'mini-text';
  const title = document.createElement('strong'), artist = document.createElement('span'); artist.className = 'meta'; text.append(title, artist);
  const expand = button('expand', '元の画面へ', () => engine.expand?.());
  const queue = button('queue', '再生待ち', () => engine.queue?.());
  const close = button('close', '再生を閉じる', () => engine.close?.());
  const top = document.createElement('div'); top.className = 'mini-top'; top.append(art, text, queue, expand, close);
  const prev = button('prev', '前の曲', () => engine.prev?.());
  const toggle = button('play', '再生', () => engine.toggle?.());
  toggle.classList.add('mini-primary');
  const next = button('next', '次の曲', () => engine.next?.());
  const seek = document.createElement('input'); seek.type = 'range'; seek.className = 'mini-seek'; seek.min = '0'; seek.max = '100'; seek.value = '0'; seek.step = '1'; seek.setAttribute('aria-label', '再生位置');
  seek.addEventListener('input', () => engine.seek?.(Number(seek.value)));
  const time = document.createElement('span'); time.className = 'mini-time meta';
  const bottom = document.createElement('div'); bottom.className = 'mini-bottom'; bottom.append(prev, toggle, next, seek, time);
  host.append(top, bottom);
  document.body.append(host);

  let corner = readCorner(storage) ?? 'br', dragging = null;
  const view = () => ({ width: window.innerWidth, height: window.innerHeight });
  const size = () => { const box = host.getBoundingClientRect(); return { width: box.width || W, height: box.height || 72 }; };
  const dockHeight = () => {
    const el = dock?.element;
    if (!el || el.hidden || !el.classList.contains('is-mini')) return 0;
    return el.getBoundingClientRect().height || 0;
  };
  function place() {
    if (host.hidden) return;
    if (dragging) { Object.assign(host.style, { right: `${dragging.right}px`, bottom: `${dragging.bottom}px` }); return; }
    // 本文の列の中に置く（右列のアイコン帯に重ねない）。本文の列が測れなければ窓全体。
    const main = document.querySelector('.workspace-main')?.getBoundingClientRect?.();
    const inMain = main && main.width > 0 && main.right <= view().width;
    const frame = inMain ? { width: main.right - main.left, height: view().height } : view();
    const base = cornerInsets(corner, size(), frame);
    if (inMain) base.right += view().width - main.right;
    // 同じ隅に YouTube の小窓があるときは、その分だけずらして重ねない。
    const bottom = stackedBottom(corner, base.bottom, dockHeight());
    const clamped = clampInsets({ right: base.right, bottom }, size(), view());
    Object.assign(host.style, { right: `${clamped.right}px`, bottom: `${clamped.bottom}px` });
  }
  function paint() {
    const s = engine.state?.() ?? {};
    const track = s.track ?? null;
    host.hidden = !track;
    document.body.classList.toggle('has-mini-player', Boolean(track));
    if (!track) return;
    title.textContent = track.title || '楽曲';
    artist.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
    artLetter.textContent = (String(track.title ?? '').trim().slice(0, 1) || '♪').toUpperCase();
    const url = typeof s.artwork === 'string' && s.artwork.startsWith('blob:') ? s.artwork : '';
    if (url) { artImg.src = url; artImg.hidden = false; artImg.onerror = () => { artImg.hidden = true; }; }
    else { artImg.hidden = true; artImg.removeAttribute('src'); }
    const playing = !s.paused;
    toggle.replaceChildren(icon(document, playing ? 'pause' : 'play'));
    toggle.setAttribute('aria-label', playing ? '一時停止' : '再生'); toggle.title = toggle.getAttribute('aria-label');
    prev.disabled = !s.hasPrev; next.disabled = !s.hasNext;
    const duration = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0;
    seek.max = String(duration || 100); seek.disabled = !duration;
    if (document.activeElement !== seek) seek.value = String(Math.min(s.currentTime || 0, duration || 100));
    time.textContent = `${clock(s.currentTime)} / ${clock(duration)}`;
    place();
  }

  // 上の段をつかんで動かす。離したら最も近い隅に吸着して覚える。
  top.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    const box = host.getBoundingClientRect(), start = { x: event.clientX, y: event.clientY };
    const from = { right: view().width - box.right, bottom: view().height - box.bottom };
    host.classList.add('is-dragging');
    top.setPointerCapture?.(event.pointerId);
    const move = e => { dragging = clampInsets({ right: from.right - (e.clientX - start.x), bottom: from.bottom - (e.clientY - start.y) }, size(), view()); place(); };
    const up = () => {
      top.removeEventListener('pointermove', move); top.removeEventListener('pointerup', up); top.removeEventListener('pointercancel', up);
      host.classList.remove('is-dragging');
      if (dragging) {
        const s = size();
        corner = nearestCorner({ left: view().width - dragging.right - s.width, top: view().height - dragging.bottom - s.height, width: s.width, height: s.height }, view());
        writeCorner(storage, corner);
      }
      dragging = null; place();
    };
    top.addEventListener('pointermove', move); top.addEventListener('pointerup', up); top.addEventListener('pointercancel', up);
  });
  window.addEventListener('resize', place);
  const offEngine = engine.subscribe?.(paint) ?? (() => {});
  const offDock = dock?.subscribe?.(() => place()) ?? (() => {});
  paint();
  return {
    element: host,
    refresh: paint,
    corner: () => corner,
    setCorner(next) { corner = next; writeCorner(storage, corner); place(); },
    destroy() { offEngine(); offDock(); window.removeEventListener('resize', place); host.remove(); document.body.classList.remove('has-mini-player'); },
  };
}
