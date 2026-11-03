// ショートの縦フィード（Hub Desktop）。1画面に1枚、CSS の scroll-snap で送る（仕組みの写しは docs/hub-ui-reference/REEL-MECHANICS.md）。
// いま見えている1枚（IntersectionObserver で6割以上）だけを再生する。
//   YouTube … 共有の youtube-nocookie dock の iframe（常に1つ）。Hub動画 … 同梱 hls.js の <video>（現在の1枚と次の1枚だけ作る）。
// 次の1枚だけ先読みする（Hub動画は頭出し、YouTube は表紙の読み込みを前倒し）。それ以外の動画は作らない・外す。
// カードの縦横比は動画ごと（縦 9:16／横 16:9）。カードの高さは変えず、枠を中央に置いて切り抜かない。
// 音は消音で始め、右列のボタンで切り替える。選んだ状態は起動中ずっと覚える。再生は playback-owner を通す。
// DOM は textContent / createElement(NS) だけ。
import { videoYouTubeId, createVideoThumbnail } from './video-home.mjs';
import { filterVideos, unplayable } from './yt-unplayable.mjs';
import { createLikeButton, loadEngagement, setVideoLike } from './video-engagement.mjs';
import { isNativeVideo } from './native-video.mjs';
import { attachNativeHls } from './native-video-player.mjs';
import { isShortVideo } from './sidebar-media.mjs';

export const VISIBLE_RATIO = 0.6;
export const SHORT_RATIO = 9 / 16;
export const LANDSCAPE_RATIO = 16 / 9;
export const WHEEL_LOCK_MS = 450;
export const SOUND_FALLBACK_MS = 3000;
const MUTE_KEY = 'hub.desktop.shortsMuted';
const KEY_DIRECTION = { ArrowDown: 'ArrowDown', j: 'ArrowDown', ArrowUp: 'ArrowUp', k: 'ArrowUp' };

/** ↑↓・j/k で移る先の番号。端では動かない。ほかのキーは null。 */
export function nextShortIndex(current, key, length) {
  if (!Number.isInteger(length) || length <= 0) return null;
  const at = Number.isInteger(current) && current >= 0 ? Math.min(current, length - 1) : 0;
  const direction = KEY_DIRECTION[key];
  if (direction === 'ArrowDown') return Math.min(length - 1, at + 1);
  if (direction === 'ArrowUp') return Math.max(0, at - 1);
  return null;
}

/** 入力欄・選択・編集可能な場所では ↑↓ を横取りしない。 */
export function isEditableTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = String(node.tagName).toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return node.isContentEditable === true || node.getAttribute?.('contenteditable') === '' || node.getAttribute?.('contenteditable') === 'true';
}

/** 見えている割合の表から、しきい値以上でいちばん大きい1本。無ければ null。 */
export function pickVisible(ratios, threshold = VISIBLE_RATIO) {
  let best = null, bestRatio = threshold;
  for (const [index, ratio] of ratios) if (ratio >= bestRatio && (best === null || ratio > bestRatio || index < best)) { best = index; bestRatio = ratio; }
  return best;
}

function parseRatio(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const pair = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/u.exec(value);
  if (pair) return Number(pair[2]) > 0 ? Number(pair[1]) / Number(pair[2]) : null;
  const plain = Number(value);
  return Number.isFinite(plain) && plain > 0 ? plain : null;
}

/**
 * カードの縦横比（幅÷高さ）。提供元の寸法（aspectRatio、無ければ width/height）を使い、
 * 無ければ、ショート（60秒以下）は 9:16、ふつうの動画は 16:9。極端な値は丸める。
 */
export function shortAspect(video) {
  let ratio = parseRatio(video?.aspectRatio) ?? parseRatio(video?.aspect);
  if (ratio === null) {
    const width = Number(video?.width), height = Number(video?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) ratio = width / height;
  }
  if (ratio === null) ratio = isShortVideo(video) ? SHORT_RATIO : LANDSCAPE_RATIO;
  return Math.min(3, Math.max(0.3, ratio));
}

function nativePlayable(video) {
  return isNativeVideo(video) && Boolean(video.id) && video.availabilityStatus !== 'unavailable';
}
function youtubePlayable(video) {
  return Boolean(videoYouTubeId(video)) && video.availabilityStatus !== 'unavailable';
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ICONS = {
  mute: 'M4 9v6h4l5 5V4L8 9H4zm12.5 3l2.8-2.8-1-1-2.8 2.8-2.8-2.8-1 1 2.8 2.8-2.8 2.8 1 1 2.8-2.8 2.8 2.8 1-1z',
  sound: 'M4 9v6h4l5 5V4L8 9H4zm12 3a4 4 0 0 0-2-3.5v7A4 4 0 0 0 16 12zm-2-7.7v2.1a5.9 5.9 0 0 1 0 11.2v2.1a8 8 0 0 0 0-15.4z',
  comment: 'M4 4h16v12H8l-4 4V4z',
  more: 'M6 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
};
function icon(doc, name) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}
function iconButton(doc, name, label, className) {
  const button = el(doc, 'button', `vid-short-icon ${className}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(doc, name));
  return button;
}

// 音の状態は起動中ずっと覚える（sessionStorage が使えなければ、この窓の中だけ）。既定は消音。
const fallbackStore = new Map();
function defaultStorage(window) {
  try { const store = window.sessionStorage; store.getItem(MUTE_KEY); return store; } catch { return { getItem: (k) => fallbackStore.get(k) ?? null, setItem: (k, v) => { fallbackStore.set(k, String(v)); } }; }
}

export function createShortsFeed({ document, items: allItems, dock, owner = null, hubAsset, signedIn = false, invoke = null, onOpenChannel = () => {}, onOpenVideo = () => {}, observerFactory = null, attachHls = attachNativeHls, nativeDeps = {}, storage = null, now = () => Date.now(), setTimer = (fn, ms) => document.defaultView.setTimeout(fn, ms), clearTimer = (id) => document.defaultView.clearTimeout(id) }) {
  const window = document.defaultView;
  const call = typeof invoke === 'function' ? invoke : async () => ({});
  const hubPlay = typeof invoke === 'function';
  const store = storage ?? defaultStorage(window);
  const items = filterVideos(allItems);
  const feed = el(document, 'div', 'vid-shorts-feed');
  feed.tabIndex = 0;
  feed.setAttribute('role', 'feed');
  feed.setAttribute('aria-label', 'ショート');
  const sections = [];
  const ratios = new Map();
  const engaged = new Set();
  const natives = new Map();
  let active = null, playingKey = null, destroyed = false, lastStep = -Infinity, soundTimer = null;
  let muted = true;
  try { muted = store.getItem(MUTE_KEY) !== '0'; } catch { /* 既定の消音 */ }

  const makeObserver = observerFactory ?? ((callback, options) => (typeof window.IntersectionObserver === 'function' ? new window.IntersectionObserver(callback, options) : null));
  const playable = (video) => youtubePlayable(video) || (hubPlay && nativePlayable(video));

  const soundButtons = [];
  function paintSound() {
    for (const button of soundButtons) {
      button.replaceChildren(icon(document, muted ? 'mute' : 'sound'));
      const label = muted ? '音を出す' : '音を消す';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.setAttribute('aria-pressed', String(!muted));
    }
  }
  function setMuted(on, { persist = true } = {}) {
    muted = on;
    if (persist) { try { store.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* 覚えられなくても動く */ } }
    for (const entry of natives.values()) entry.el.muted = on;
    if (playingKey !== null) dock.setMuted?.(on);
    paintSound();
  }

  items.forEach((video, index) => {
    const ratio = shortAspect(video);
    const section = el(document, 'section', `vid-short ${ratio >= 1 ? 'is-landscape' : 'is-portrait'}`);
    section.dataset.index = String(index);
    section.style.setProperty('--ar', String(Math.round(ratio * 10000) / 10000));
    section.setAttribute('aria-label', video.title || 'ショート');
    const frame = el(document, 'div', 'vid-short-frame');
    const stage = el(document, 'div', 'vid-short-stage');
    const poster = createVideoThumbnail(document, video, { hubAsset });
    poster.classList.add('vid-short-poster');
    poster.style.setProperty('--ratio', ratio >= 1 ? '16 / 9' : '9 / 16');
    const slot = el(document, 'div', 'yt-player yt-player-slot vid-short-slot');
    stage.append(poster, slot);
    const showOpen = () => {
      if (stage.querySelector('.vid-short-open')) return;
      const open = el(document, 'button', 'video-play vid-short-open', '詳細を開く');
      open.type = 'button';
      open.onclick = () => onOpenVideo(video);
      stage.append(open);
    };
    if (!playable(video)) showOpen();
    // 右列：音・いいね・コメント（詳細を開く）・その他。平らなアイコンボタン。
    const rail = el(document, 'div', 'vid-short-rail');
    const actions = el(document, 'div', 'vid-short-actions');
    if (playable(video)) {
      const sound = iconButton(document, 'mute', '音を出す', 'vid-short-sound');
      sound.onclick = () => setMuted(!muted);
      soundButtons.push(sound);
      rail.append(sound);
    }
    const comment = iconButton(document, 'comment', 'コメントを見る', 'vid-short-comment');
    comment.onclick = () => onOpenVideo(video);
    const more = iconButton(document, 'more', 'その他', 'vid-short-more');
    more.setAttribute('aria-haspopup', 'true');
    more.setAttribute('aria-expanded', 'false');
    const sheet = el(document, 'div', 'vid-short-sheet');
    sheet.hidden = true;
    sheet.setAttribute('role', 'menu');
    const entries = [['詳細を開く', () => onOpenVideo(video)]];
    if (video.provider === 'hub' && typeof video.channelHandle === 'string' && video.channelHandle) entries.push(['チャンネルを開く', () => onOpenChannel(video.channelHandle)]);
    const closeSheet = () => { sheet.hidden = true; more.setAttribute('aria-expanded', 'false'); };
    for (const [label, run] of entries) {
      const item = el(document, 'button', 'vid-short-sheet-item', label);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.onclick = () => { closeSheet(); run(); };
      sheet.append(item);
    }
    more.onclick = () => { const open = sheet.hidden; sheet.hidden = !open; more.setAttribute('aria-expanded', String(open)); };
    sheet.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeSheet(); more.focus?.(); } });
    rail.append(actions, comment, more, sheet);
    frame.append(stage, rail);
    const info = el(document, 'div', 'vid-short-info');
    info.append(el(document, 'strong', 'vid-short-title', video.title || '動画'));
    const channelName = video.channel || '配信元不明';
    if (video.provider === 'hub' && typeof video.channelHandle === 'string' && video.channelHandle) {
      const link = el(document, 'button', 'vid-short-channel link', channelName);
      link.type = 'button';
      link.onclick = () => onOpenChannel(video.channelHandle);
      info.append(link);
    } else info.append(el(document, 'span', 'meta vid-short-channel', channelName));
    section.append(frame, info);
    Object.assign(section, { _slot: slot, _actions: actions, _stage: stage, _showOpen: showOpen, _closeSheet: closeSheet });
    sections.push(section);
    feed.append(section);
  });
  paintSound();

  function mountLike(index) {
    const video = items[index], section = sections[index];
    if (!video || !section || engaged.has(video.id)) return;
    engaged.add(video.id);
    const paint = (state) => {
      if (destroyed) return;
      section._actions.replaceChildren(createLikeButton(document, { state, signedIn, compact: true, onSet: (liked) => setVideoLike(call, video.id, liked) }));
    };
    if (!signedIn) { paint({ likeCount: 0, liked: false }); return; }
    void loadEngagement(call, video.id).then((state) => paint(state ?? { likeCount: 0, liked: false }));
  }

  // ---- Hub動画（同梱 hls.js）。現在の1枚と次の1枚だけ作る ----
  function playNative(entry) {
    entry.el.muted = muted;
    const result = entry.el.play?.();
    result?.catch?.(() => {
      // 音ありで拒まれたら消音でもう一度。黙って止まると真っ黒のままになる。
      if (entry.el.muted || destroyed) return;
      setMuted(true, { persist: false });
      entry.el.play?.()?.catch?.(() => {});
    });
  }
  function dropNative(index) {
    const entry = natives.get(index);
    if (!entry) return;
    natives.delete(index);
    entry.stopped = true;
    entry.playback?.destroy?.();
    entry.el.pause?.();
    entry.el.removeAttribute?.('src');
    entry.progress.remove();
    entry.el.remove();
  }
  function mountNative(index) {
    const existing = natives.get(index);
    if (existing) return existing;
    const video = items[index], section = sections[index];
    const player = el(document, 'video', 'vid-short-native');
    player.playsInline = true;
    player.loop = true;
    player.muted = muted;
    player.preload = 'metadata';
    player.setAttribute('aria-label', video.title || 'ショート');
    const fill = el(document, 'span', 'vid-short-progress-fill');
    const progress = el(document, 'div', 'vid-short-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', '再生位置');
    progress.append(fill);
    const entry = { el: player, progress, playback: null, ready: false, wantPlay: false, stopped: false };
    player.addEventListener('timeupdate', () => { if (player.duration > 0) fill.style.width = `${Math.min(100, (player.currentTime / player.duration) * 100).toFixed(2)}%`; });
    progress.addEventListener('click', (event) => {
      if (!(player.duration > 0)) return;
      const box = progress.getBoundingClientRect();
      if (box.width > 0) player.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * player.duration;
    });
    player.addEventListener('click', () => setMuted(!muted));
    section._stage.insertBefore(player, section._slot);
    section._stage.append(progress);
    natives.set(index, entry);
    const failed = () => {
      if (entry.stopped) return;
      dropNative(index);
      section._showOpen();
      if (active === index) paintSound();
    };
    Promise.resolve()
      .then(() => attachHls(player, { ...nativeDeps, play: () => call('native_video_play', { id: video.id }), onError: failed }))
      .then((attached) => {
        if (entry.stopped) { attached?.destroy?.(); return; }
        entry.playback = attached; entry.ready = true;
        if (entry.wantPlay) playNative(entry);
      })
      .catch(failed);
    return entry;
  }

  function stopPlaying() {
    if (playingKey === null) return;
    const key = playingKey;
    playingKey = null;
    if (dock.isPlaying(key)) dock.stop();
  }

  // 現在の1枚と次の1枚だけ生かす。次の1枚だけ先読みし、それ以外は外す。
  function reconcile() {
    const keep = new Set();
    if (active !== null) {
      keep.add(active);
      for (let next = active + 1; next < sections.length; next++) if (!sections[next].hidden) { keep.add(next); break; }
    }
    for (const index of [...natives.keys()]) if (!keep.has(index)) dropNative(index);
    sections.forEach((section, index) => {
      const warm = active !== null && index !== active && keep.has(index);
      const img = section.querySelector('.vid-short-poster img');
      if (warm) { section.dataset.warm = '1'; if (img) img.loading = 'eager'; } else { delete section.dataset.warm; if (img) img.loading = 'lazy'; }
      if (warm && hubPlay && nativePlayable(items[index])) mountNative(index);
    });
  }

  function activate(index) {
    if (destroyed || index === active) return;
    const previous = active;
    active = index;
    if (soundTimer !== null) { clearTimer(soundTimer); soundTimer = null; }
    const old = previous === null ? null : natives.get(previous);
    if (old) { old.wantPlay = false; old.el.pause?.(); }
    sections[previous]?._closeSheet?.();
    const video = items[index];
    if (!video) { stopPlaying(); reconcile(); return; }
    mountLike(index);
    if (!playable(video)) { stopPlaying(); reconcile(); return; }
    // 始める前に Hub の曲・右列のブラウザを止める（dock 自身は止めない）。
    owner?.claim('yt-dock');
    if (nativePlayable(video) && hubPlay && !youtubePlayable(video)) {
      stopPlaying();
      const entry = mountNative(index);
      entry.wantPlay = true;
      if (entry.ready) playNative(entry);
      reconcile();
      return;
    }
    const key = `video:${video.id}`;
    // 再生できない動画は黙って次の再生できる動画へ進み、その行は外す。
    const skip = () => {
      if (destroyed || active !== index) return;
      playingKey = null;
      sections[index].hidden = true; sections[index].setAttribute('aria-hidden', 'true');
      reconcile();
      for (let next = index + 1; next < items.length; next++) if (!sections[next].hidden && playable(items[next]) && !unplayable().has(videoYouTubeId(items[next]))) { goTo(next); return; }
    };
    const ok = dock.play({ key, id: videoYouTubeId(video), title: video.title || 'YouTube動画', subtitle: video.channel || '', slot: sections[index]._slot, onOpen: null, autoplay: true, quiet: true, onUnplayable: skip, muted, loop: true });
    playingKey = ok ? key : null;
    // 音ありで始まらなければ消音で続ける（始めは消音、タップで音を出すのが基本）。
    if (ok && !muted) {
      soundTimer = setTimer(() => {
        soundTimer = null;
        if (destroyed || active !== index || playingKey !== key || dock.state?.().playingNow) return;
        setMuted(true, { persist: false });
        dock.resume?.();
      }, SOUND_FALLBACK_MS);
    }
    reconcile();
  }

  const observer = makeObserver((entries) => {
    for (const entry of entries) {
      const index = Number(entry.target?.dataset?.index);
      if (Number.isInteger(index)) ratios.set(index, entry.isIntersecting ? entry.intersectionRatio : 0);
    }
    const next = pickVisible(ratios);
    if (next !== null) activate(next);
  }, { root: feed, threshold: [0, 0.25, 0.5, VISIBLE_RATIO, 0.75, 1] });
  if (observer) for (const section of sections) observer.observe(section);

  // フィード全体が見えなくなったら止める（別の画面へ移ったとき）。
  const outer = makeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry && !entry.isIntersecting) {
      active = null; ratios.clear(); stopPlaying();
      if (soundTimer !== null) { clearTimer(soundTimer); soundTimer = null; }
      for (const index of [...natives.keys()]) dropNative(index);
      reconcile();
    }
  }, { threshold: [0] });
  if (outer) outer.observe(feed);

  const smooth = () => { try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; } catch { return 'auto'; } };
  function goTo(index) {
    if (!sections[index]) return;
    // 1枚の高さはフィードの高さと同じ。祖先（本文）まで動かさないよう、フィードだけをスクロールする。外した行は数えない。
    let before = 0;
    for (let i = 0; i < index; i++) if (!sections[i].hidden) before++;
    const top = before * feed.clientHeight;
    if (typeof feed.scrollTo === 'function') feed.scrollTo({ top, behavior: smooth() });
    else feed.scrollTop = top;
  }
  // 外した行は飛ばして、同じ向きに1枚進む。
  function stepTarget(key) {
    const from = active ?? 0;
    let next = nextShortIndex(from, key, sections.length);
    if (next === null) return null;
    const direction = next > from ? 1 : -1;
    while (next !== from && sections[next]?.hidden) {
      const after = next + direction;
      if (after < 0 || after >= sections.length) return from;
      next = after;
    }
    return next;
  }
  function onKey(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!KEY_DIRECTION[event.key]) return;
    if (isEditableTarget(event.target)) return;
    if (event.currentTarget !== feed) {
      // 文書全体で受けるのは、何にも焦点が無いか、フィードの中に焦点があるときだけ。
      const focus = document.activeElement;
      if (focus && focus !== document.body && !feed.contains(focus)) return;
      if (isEditableTarget(focus) || !feed.isConnected || feed.checkVisibility?.() === false) return;
    }
    const next = stepTarget(event.key);
    if (next === null) return;
    event.preventDefault();
    if (next !== (active ?? 0) || active === null) goTo(next);
  }
  // ホイールは1回の操作で1枚だけ送る（慣性で何枚も飛ばさない）。
  function onWheel(event) {
    if (event.ctrlKey || event.defaultPrevented || !event.deltaY || Math.abs(event.deltaY) < 4) return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    const at = now();
    if (at - lastStep < WHEEL_LOCK_MS) return;
    const next = stepTarget(event.deltaY > 0 ? 'ArrowDown' : 'ArrowUp');
    if (next === null || (next === (active ?? 0) && active !== null)) return;
    lastStep = at;
    goTo(next);
  }
  feed.addEventListener('keydown', onKey);
  feed.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKey);

  return {
    element: feed,
    goTo,
    active: () => active,
    muted: () => muted,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect?.();
      outer?.disconnect?.();
      if (soundTimer !== null) clearTimer(soundTimer);
      document.removeEventListener('keydown', onKey);
      feed.removeEventListener('keydown', onKey);
      feed.removeEventListener('wheel', onWheel);
      for (const index of [...natives.keys()]) dropNative(index);
      stopPlaying();
    },
  };
}
