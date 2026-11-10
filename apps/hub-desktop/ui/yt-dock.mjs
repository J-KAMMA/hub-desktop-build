// 動画と音楽で共有する1つの再生枠。iframe は動かさず（動かすと読み込み直して止まる）、
// 枠の位置だけを変える。視聴画面では置き場（slot）の上に重ね、画面を離れたら右下の小窓になる。
// 小窓は見出しをつかんで動かせる。ブラウザのタブ（ネイティブの子webview）の上でも見えるよう、
// 小窓の矩形を browser_mini_overlay で伝えてページをその分だけ切り抜く。
import { createYouTubePlayer } from './youtube-embed.mjs';
import { unplayable, isUnplayableCode, isTransientCode } from './yt-unplayable.mjs';
import { readCorner, writeCorner, nearestCorner, cornerInsets } from './mini-snap.mjs';

export const UNPLAYABLE_NOTE = 'この曲はアプリ内で再生できないため一覧から外しました';
export const TRANSIENT_NOTE = '再生できませんでした';
const NOTE_MS = 4000;

// 既定の置き場は本文の右下（右列を開いていれば右列の左）。16:9 で 356×200（再生中の埋め込みは 200×200 以上の見える大きさを保つ規則）、頭の段は 40。
// 利用者が動かした位置だけを覚える（v2: 既定を変えたので、旧い v1 の位置は引き継がない）。
const KEY = 'hub.miniPlayer.position.v2';
const MINI_W = 356, MINI_H = 200, HEAD_H = 40, MARGIN = 16;

function readPosition(storage) {
  try { const value = JSON.parse(storage?.getItem(KEY) ?? 'null'); return Number.isFinite(value?.right) && Number.isFinite(value?.bottom) ? value : null; } catch { return null; }
}
function writePosition(storage, value) { try { storage?.setItem(KEY, JSON.stringify(value)); } catch { /* 位置は覚えられなくても再生は続ける */ } }

const YT_ORIGIN = 'https://www.youtube-nocookie.com';

export function createYouTubeDock({ document, invoke = async () => {}, stage = () => null, storage = null, owner = null, store = null } = {}) {
  const unplayableStore = () => store ?? unplayable();
  const window = document.defaultView;
  const host = document.createElement('div');
  host.className = 'yt-dock'; host.hidden = true;
  host.setAttribute('role', 'region'); host.setAttribute('aria-label', '再生中');
  const head = document.createElement('div'); head.className = 'yt-dock-head';
  const text = document.createElement('div'); text.className = 'yt-dock-text';
  const title = document.createElement('strong'), subtitle = document.createElement('span');
  subtitle.className = 'meta'; text.append(title, subtitle);
  const back = document.createElement('button'); back.type = 'button'; back.className = 'yt-dock-back'; back.textContent = '詳細へ'; back.title = '再生していた画面に戻る';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'yt-dock-close'; close.textContent = '×'; close.title = '再生を閉じる'; close.setAttribute('aria-label', '再生を閉じる');
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'yt-dock-toggle'; toggle.textContent = '▶'; toggle.title = '再生'; toggle.setAttribute('aria-label', '再生');
  head.append(text, toggle, back, close);
  const body = document.createElement('div'); body.className = 'yt-dock-body';
  host.append(head, body);
  document.body.append(host);

  let waitFrames = 0, current = null, slot = null, mini = false, position = readPosition(storage), sentHole = '';
  const listeners = new Set();
  const notify = () => {
    const on = current?.playingNow === true;
    toggle.textContent = on ? 'Ⅱ' : '▶'; toggle.title = on ? '一時停止' : '再生'; toggle.setAttribute('aria-label', toggle.title);
    for (const fn of listeners) { try { fn(state()); } catch { /* 片方の失敗で他を止めない */ } }
  };
  const state = () => ({ playing: current !== null, mini, key: current?.key ?? null, playingNow: current?.playingNow === true });

  // 埋め込みの再生状態は enablejsapi の postMessage で受け取る。dock の iframe 以外と、YouTube 以外の送り元は無視する。
  const frameWindow = () => body.querySelector('iframe')?.contentWindow ?? null;
  const command = func => { try { frameWindow()?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), YT_ORIGIN); } catch { /* 送れなくても枠は壊さない */ } };
  const pause = () => { command('pauseVideo'); if (current?.playingNow) { current.playingNow = false; notify(); } };
  const listen = () => {
    const win = frameWindow(), key = current?.key;
    if (!win || !key) return;
    try { win.postMessage(JSON.stringify({ event: 'listening', id: key }), YT_ORIGIN); } catch { /* 状態が取れないだけ */ }
  };
  // 埋め込みが再生を拒んだ。覚えて、一覧から外し、枠を止める。単独の再生なら短い注意を残し、列の再生なら黙って次へ進める。
  let noteTimer = null;
  // remember=false（152/153）は、その回だけ止める。一覧からは外さず、列の再生なら次へ進める。
  function fail(id, remember = true) {
    const quiet = current?.quiet === true, onUnplayable = current?.onUnplayable;
    if (remember) unplayableStore().add(id);
    if (quiet) {
      stop();
      try { onUnplayable?.(id); } catch { /* 次へ進められなくても止まるだけ */ }
      return;
    }
    body.querySelector('iframe')?.setAttribute('src', 'about:blank');
    const line = document.createElement('p'); line.className = 'yt-dock-note meta'; line.setAttribute('role', 'status'); line.textContent = remember ? UNPLAYABLE_NOTE : TRANSIENT_NOTE;
    body.replaceChildren(line);
    current.playingNow = false;
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => { if (current?.failed) stop(); }, NOTE_MS);
    current.failed = true;
    try { onUnplayable?.(id); } catch { /* 通知の失敗で止めない */ }
    notify();
  }
  const onMessage = event => {
    if (!current || event.origin !== YT_ORIGIN || !event.source || event.source !== frameWindow()) return;
    let data = event.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
    if (data && data.event === 'onError' && isUnplayableCode(data.info)) { fail(current.id); return; }
    if (data && data.event === 'onError' && isTransientCode(data.info)) { fail(current.id, false); return; }
    if (!data || (data.event !== 'infoDelivery' && data.event !== 'onStateChange')) return;
    const code = data.event === 'onStateChange' ? data.info : data.info?.playerState;
    if (!Number.isInteger(code)) return;
    const playing = code === 1;
    if (playing === (current.playingNow === true)) return;
    current.playingNow = playing;
    if (playing) owner?.claim('yt-dock');
    notify();
  };
  window.addEventListener('message', onMessage);
  owner?.register('yt-dock', pause);
  // 見えていない窓で鳴らし続けない（再生中の埋め込みは見えていることが条件）。
  document.addEventListener('visibilitychange', () => { if (document.hidden && current?.playingNow) pause(); });

  // 利用者が動かしていなければ、本文の右下。音楽のプレーヤー（Hub の曲）が出ていればその上。
  const defaultPosition = () => {
    const main = document.querySelector('.workspace-main'), box = main?.getBoundingClientRect?.();
    if (!box || box.width <= 0) return { right: MARGIN, bottom: MARGIN };
    let floor = Math.min(box.bottom, window.innerHeight);
    const player = document.querySelector('#music-player:not([hidden])'), playerBox = player?.getBoundingClientRect?.();
    if (playerBox && playerBox.height > 0) floor = Math.min(floor, playerBox.top);
    return { right: Math.max(MARGIN, window.innerWidth - box.right + MARGIN + 8), bottom: Math.max(MARGIN, window.innerHeight - floor + MARGIN) };
  };
  // 小窓の分だけ本文の末尾に余白を足し、最後の投稿まで小窓の下から出せるようにする。
  const reserve = on => {
    document.body.classList.toggle('has-mini-dock', on);
    document.documentElement.style.setProperty('--mini-dock-reserve', on ? `${MINI_H + HEAD_H + MARGIN * 2}px` : '0px');
  };
  const clampPosition = value => {
    const w = window.innerWidth, h = window.innerHeight;
    return { right: Math.min(Math.max(value.right, MARGIN), Math.max(MARGIN, w - MINI_W - MARGIN)), bottom: Math.min(Math.max(value.bottom, MARGIN), Math.max(MARGIN, h - MINI_H - HEAD_H - MARGIN)) };
  };
  function sendHole() {
    let rect = [0, 0, 0, 0];
    if (current && mini && !host.hidden) {
      const box = host.getBoundingClientRect(), page = stage()?.getBoundingClientRect?.();
      if (page && page.width > 0 && page.height > 0) rect = [box.left - page.left, box.top - page.top, box.width, box.height].map(v => Math.round(v * 100) / 100);
    }
    const key = rect.join(',');
    if (key === sentHole) return;
    sentHole = key;
    const [x, y, width, height] = rect;
    void Promise.resolve(invoke('browser_mini_overlay', { x, y, width, height })).catch(() => { sentHole = ''; });
  }
  function layout() {
    if (!current) { host.hidden = true; reserve(false); sendHole(); return; }
    // 置き場がまだページに入っていない（作った直後）なら、数フレームだけ待って重ね直す。
    if (!mini && slot && !slot.isConnected && waitFrames < 60) { waitFrames++; host.hidden = true; window.requestAnimationFrame(() => layout()); return; }
    waitFrames = 0;
    host.hidden = false;
    if (!mini && slot?.isConnected && slot.checkVisibility?.() !== false) {
      const box = slot.getBoundingClientRect();
      host.classList.remove('is-mini');
      reserve(false);
      Object.assign(host.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, right: '', bottom: '' });
      body.style.height = `${box.height}px`;
      // 置き場がスクロールで上下にはみ出した分は切り落とす（上の帯やほかの列に重ねない）。
      const frame = slot.closest('.workspace-main, main, .rail-view')?.getBoundingClientRect();
      const top = frame ? Math.max(0, frame.top - box.top) : 0, bottom = frame ? Math.max(0, box.bottom - frame.bottom) : 0;
      host.style.clipPath = top || bottom ? `inset(${top}px 0 ${bottom}px 0)` : '';
    } else {
      mini = true;
      host.classList.add('is-mini');
      const corner = position ? null : readCorner(storage), shown = clampPosition(position ?? (corner ? cornerInsets(corner, { width: MINI_W, height: MINI_H + HEAD_H }, { width: window.innerWidth, height: window.innerHeight }) : defaultPosition()));
      reserve(true);
      Object.assign(host.style, { left: '', top: '', width: `${MINI_W}px`, right: `${shown.right}px`, bottom: `${shown.bottom}px`, clipPath: '' });
      body.style.height = `${MINI_H}px`;
    }
    sendHole();
  }

  // 置き場の大きさ・スクロール・窓の大きさが変わったら追う。常時のループは回さない（待機中のCPUを食うため）。
  const resize = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(() => layout()) : null;
  const onScroll = () => { if (current && !mini) layout(); };
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', () => layout());

  // 見出しをつかんで動かす。つかんでいる間は iframe にポインタを渡さない（渡すと離した合図を取り逃がす）。
  head.addEventListener('pointerdown', event => {
    if (!mini || event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    const from = clampPosition(position ?? defaultPosition());
    const start = { x: event.clientX, y: event.clientY, right: from.right, bottom: from.bottom };
    host.classList.add('is-dragging');
    head.setPointerCapture?.(event.pointerId);
    const move = e => { position = clampPosition({ right: start.right - (e.clientX - start.x), bottom: start.bottom - (e.clientY - start.y) }); layout(); };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); host.classList.remove('is-dragging'); if (position) { snap(); writePosition(storage, position); } };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });

  // 離したら最も近い隅に吸着する。隅は音楽の小窓（mini-player.mjs）と共有する。
  function snap() {
    const view = { width: window.innerWidth, height: window.innerHeight }, size = { width: MINI_W, height: MINI_H + HEAD_H };
    const corner = nearestCorner({ left: view.width - position.right - size.width, top: view.height - position.bottom - size.height, width: size.width, height: size.height }, view);
    position = clampPosition(cornerInsets(corner, size, view)); writeCorner(storage, corner); layout(); notify();
  }
  function attachSlot(next) {
    if (slot && resize) resize.unobserve(slot);
    slot = next ?? null;
    if (slot && resize) resize.observe(slot);
  }
  function stop() {
    if (!current) return false;
    body.querySelector('iframe')?.setAttribute('src', 'about:blank');
    window.clearTimeout(noteTimer);
    body.replaceChildren(); current = null; mini = false; attachSlot(null);
    layout(); notify(); return true;
  }
  close.onclick = () => stop();
  toggle.onclick = () => { if (current?.playingNow) pause(); else { command('playVideo'); } };
  back.onclick = () => { const open = current?.onOpen; if (typeof open === 'function') open(); };

  return {
    element: host,
    /** key が同じものが再生中なら iframe はそのままで、置き場だけ付け替える（小窓から戻ったとき）。 */
    play({ key, id, title: name = 'YouTube', subtitle: sub = '', slot: target, onOpen = null, autoplay = true, quiet = false, onUnplayable = null, muted = false, loop = false }) {
      // 再生できないと分かっている動画は枠を作らない。列の再生なら黙って次へ、単独なら断る。
      if (unplayableStore().has(id)) { try { onUnplayable?.(id); } catch { /* 無視 */ } return false; }
      if (current?.key !== key) {
        const player = createYouTubePlayer(document, { id, title: name, autoplay, mute: muted, loop });
        if (!player) return false;
        body.querySelector('iframe')?.setAttribute('src', 'about:blank');
        body.replaceChildren(player);
        current = { key, id, playingNow: false };
        player.querySelector('iframe')?.addEventListener('load', listen);
      }
      current.onOpen = onOpen; current.quiet = quiet; current.onUnplayable = onUnplayable;
      title.textContent = name; subtitle.textContent = sub;
      mini = false; attachSlot(target); layout(); notify(); return true;
    },
    /** 置き場の画面を離れた。再生中なら小窓にする。 */
    release(target) {
      if (!current || (target && slot && target !== slot)) return;
      // 動画は画面を離れたら止める（小窓には残すので、中の再生ボタンで続けられる）。音楽の key は常駐のプレーヤーなので鳴らしたまま。
      if (String(current.key).startsWith('video:')) pause();
      attachSlot(null); mini = true; layout(); notify();
    },
    stop,
    pause,
    /** 音だけを止める／戻す。再生は始めも止めもしない。戻すのは、止めたときだけ。 */
    /** 埋め込みの音を切り替える（enablejsapi の postMessage）。消すときは再生も続ける。 */
    setMuted(on) { command(on ? 'mute' : 'unMute'); if (on) command('playVideo'); },
    resume() { command('playVideo'); },
    layout,
    isPlaying: key => current !== null && current.key === key,
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
