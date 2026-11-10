// 右列の音楽パネル（2026-10-24 所有者: 右列の音楽は右列の中だけで完結させ、中央の画面を切り替えない）。
//
// 検索・曲の再生・アーティスト／アルバム／再生リスト／「すべて見る」の掘り下げは、すべてこの列の中で描く。
// 掘り下げは右列の戻る・進む（railNav）の履歴に積む。ここは中央の画面へ移る関数（openDetail・setView・
// navigate・enterBrowser など）を一切受け取らないし、呼ばない。再生の実体（音声の再生待ち・YouTube の
// 埋め込み枠）は app.js の共有エンジンを deps 経由で使い、YouTube の枠は右列の置き場（ytHost）に置く。
import { createArtwork, youtubeSource } from './music-youtube.mjs';
import { railAvatar, railRow } from './rail-panels.mjs';
import { musicMenuButton } from './music-track-menu.mjs';
import { openLicenseLabel, licenseDeedUrl } from './content-license.mjs';
import { DOWNLOAD_NONE_NOTICE, DOWNLOAD_WATERMARK_NOTICE } from './content-download.mjs';

const HUB_TRACK = /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PREVIEW = 10;
const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (document, label, onClick, className = 'rail-music-link', aria) => {
  const node = el(document, 'button', className, label);
  node.type = 'button';
  if (aria) node.setAttribute('aria-label', aria);
  node.onclick = onClick;
  return node;
};

/** Hub の公開曲として再生できる作品なら再生用の曲に直す。 */
export const railTrackOf = (work) => (typeof work?.id === 'string' && HUB_TRACK.test(work.id) ? { ...work, id: work.id.slice(6) } : null);

/**
 * deps（すべて右列の中で完結するもの）:
 *  getTracks() / getWorks()                       右列が読み込んだ公開曲・作品（中央の検索結果とは別）
 *  loadCatalog(query) -> {tracks, works}          検索（music_tracks と hub_resource music）
 *  isHubOriginalWork(work)
 *  playTrack(track, queue) / enqueue(track)       共有の再生エンジン
 *  player: {state(), subscribe(fn), toggle(), prev(), next(), seek(seconds)}   共有の音声エンジンの状態（任意。あれば一覧の先頭に再生カード）
 *  youtube: {play(work, panel), stop(), isPlaying(workId), active(), subscribe(fn)}   共有の YouTube 枠
 *  collection({host, kind, name, artist, actions, isCurrent})   アーティスト／アルバムの頁
 *  library({host, actions, isCurrent}) / playlists({host, actions, isCurrent})
 *  posts({host, work, isCurrent}) / report({host, work, isCurrent, open}) / download(work)   作品の下に出すポスト・報告・ダウンロード
 *  nav: {visit(route)}                            右列の戻る・進む履歴に積む
 */
export function createRailMusic({ document, host, ytHost, deps, hubAsset = null }) {
  let route = { type: 'list' };
  let disposeRoute = null;
  let unsubscribe = null;
  let turn = 0;

  const current = (mine) => () => mine === turn;
  const reset = () => {
    turn++;
    if (disposeRoute) { try { disposeRoute(); } catch { /* 描き直しを止めない */ } disposeRoute = null; }
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };

  function go(next) { deps.nav.visit(next); show(next); }

  function searchForm(query = '') {
    const form = el(document, 'form', 'rail-music-search');
    form.setAttribute('role', 'search');
    const input = el(document, 'input');
    input.type = 'search'; input.maxLength = 100; input.value = query;
    input.placeholder = '曲・アーティストを探す'; input.setAttribute('aria-label', '右列で音楽を検索');
    input.className = 'rail-music-query';
    const submit = el(document, 'button', '', '検索');
    submit.type = 'submit';
    form.append(input, submit);
    form.onsubmit = (event) => {
      event.preventDefault();
      const value = input.value.trim().slice(0, 100);
      go(value ? { type: 'search', query: value } : { type: 'list' });
    };
    return form;
  }

  function heading(text, more) {
    const row = el(document, 'div', 'rail-music-heading');
    row.append(el(document, 'h3', '', text));
    if (more) row.append(button(document, 'すべて見る', more, 'rail-music-more', `${text}をすべて見る`));
    return row;
  }

  function sublinks(work) {
    const line = el(document, 'div', 'rail-music-links');
    const artist = typeof work.artist === 'string' ? work.artist.trim() : '';
    const album = typeof work.album === 'string' ? work.album.trim() : '';
    if (artist) line.append(button(document, artist, () => go({ type: 'artist', name: artist }), 'rail-music-link', `${artist}のアーティストを右列で開く`));
    if (album) line.append(button(document, album, () => go({ type: 'album', name: album, artist }), 'rail-music-link', `アルバム ${album}を右列で開く`));
    return line;
  }

  // 1曲1行：48px の絵・題・アーティスト。押すとその場で再生（公開曲は音声、YouTube は右列の枠）して一覧に留まる。⋯ に曲の操作。
  const rowKey = (work) => { const t = railTrackOf(work) ?? (work.kind === 'track' ? work : null); return t ? `t:${t.id}` : `w:${work.id ?? ''}`; };
  function itemRow(work, queue) {
    const item = el(document, 'div', 'rail-music-item');
    item.dataset.key = rowKey(work);
    const track = railTrackOf(work) ?? (work.kind === 'track' ? work : null);
    const open = track
      ? () => void deps.playTrack(track, queue.map((entry) => railTrackOf(entry) ?? entry))
      : () => { if (youtubeSource(work)) { if (deps.youtube.play(work, ytHost)) lastYoutube = work; } else go({ type: 'work', work, autoplay: true }); };
    const art = createArtwork(document, work, { hubAsset, className: 'mw-art rail-music-art' });
    item.append(railRow(document, { title: work.title || '楽曲', text: work.artist || '', avatar: art, onOpen: open }));
    const more = musicMenuButton(document, track && !HUB_TRACK.test(String(work.id ?? '')) ? { ...track, id: `music:${track.id}` } : work, { className: 'rail-music-detail' });
    item.append(more);
    return item;
  }

  const trackItem = (track) => ({ ...track, kind: 'track', artist: track.artist || 'アーティスト不明' });

  function sections(tracks, works, { limit = PREVIEW, moreRoute = null } = {}) {
    const hubWorks = works.filter((work) => deps.isHubOriginalWork(work));
    const external = works.filter((work) => !deps.isHubOriginalWork(work));
    const hub = [...tracks.map(trackItem), ...hubWorks];
    const out = [];
    const hubQueue = hub;
    if (hub.length) {
      out.push(heading('Hub Music', moreRoute && hub.length > limit ? () => go({ ...moreRoute, section: 'hub' }) : null),
        ...hub.slice(0, limit).map((work) => itemRow(work, hubQueue)));
    }
    if (external.length) {
      out.push(heading('YouTube Music', moreRoute && external.length > limit ? () => go({ ...moreRoute, section: 'external' }) : null),
        ...external.slice(0, limit).map((work) => itemRow(work, [])));
    }
    return { nodes: out, empty: !hub.length && !external.length, hub, external };
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    prev: ['M6 5h2v14H6zM20 5v14L9 12z', true], next: ['M16 5h2v14h-2zM4 5v14l11-7z', true],
    play: ['M8 5v14l11-7z', true], pause: ['M7 5h4v14H7zM13 5h4v14h-4z', true],
    queue: ['M4 7h11M4 12h11M4 17h7M18 13v7l4-3.5z', false],
  };
  function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', `rp-icon rp-icon-${name}`);
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', ICONS[name][0]);
    if (!ICONS[name][1]) path.setAttribute('class', 'is-stroke');
    svg.append(path);
    return svg;
  }
  const clock = (value) => {
    const total = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const roundButton = (name, label, onClick, className = '') => {
    const node = el(document, 'button', `rp-btn ${className}`.trim());
    node.type = 'button'; node.setAttribute('aria-label', label); node.title = label; node.onclick = onClick;
    node.append(icon(name));
    return node;
  };
  const setIcon = (node, name) => { node.replaceChildren(icon(name)); };

  let queueOpen = true;
  let lastYoutube = null;
  let syncPlayer = null;

  // 再生中のカード：大きな絵・題・アーティスト・シークバー・操作。共有エンジンの状態に合わせて差分だけ更新する。
  function playerCard(tracks, onQueueToggle) {
    const player = deps.player;
    const card = el(document, 'section', 'rail-player');
    card.setAttribute('aria-label', '再生中');
    const art = el(document, 'div', 'rp-art');
    const meta = el(document, 'div', 'rp-meta');
    const title = el(document, 'strong', 'rp-title');
    const artist = el(document, 'button', 'rp-artist rail-music-link');
    artist.type = 'button';
    meta.append(title, artist);
    const seek = el(document, 'div', 'rp-seek');
    const cur = el(document, 'span', 'rp-time rp-cur', '0:00'), total = el(document, 'span', 'rp-time rp-dur', '0:00');
    const bar = el(document, 'input', 'rp-bar');
    bar.type = 'range'; bar.min = '0'; bar.max = '100'; bar.step = '1'; bar.value = '0'; bar.setAttribute('aria-label', '再生位置');
    seek.append(cur, bar, total);
    const prev = roundButton('prev', '前の曲', () => player.prev());
    const toggle = roundButton('play', '再生', () => {}, 'rp-play');
    const next = roundButton('next', '次の曲', () => player.next());
    const queueBtn = roundButton('queue', '次に再生', () => { queueOpen = !queueOpen; queueBtn.setAttribute('aria-pressed', String(queueOpen)); onQueueToggle(); });
    queueBtn.setAttribute('aria-pressed', String(queueOpen));
    const controls = el(document, 'div', 'rp-controls');
    controls.append(prev, toggle, next, queueBtn);
    card.append(art, meta, seek, controls);
    let dragging = false, shownKey = null, shownArtist = '', current = null;
    bar.addEventListener('pointerdown', () => { dragging = true; });
    bar.addEventListener('pointerup', () => { dragging = false; });
    bar.addEventListener('input', () => { cur.textContent = clock(Number(bar.value)); });
    bar.addEventListener('change', () => { dragging = false; if (!bar.disabled) player.seek(Number(bar.value)); });
    artist.onclick = () => { if (shownArtist) go({ type: 'artist', name: shownArtist.slice(0, 128) }); };
    toggle.onclick = () => {
      if (current?.kind === 'youtube') deps.youtube.stop();
      else if (current?.kind === 'engine') player.toggle();
      else if (current?.work) void deps.playTrack(railTrackOf(current.work) ?? current.work, tracks.map((t) => railTrackOf(t) ?? t));
    };
    function update() {
      const ytId = deps.youtube.active?.() ?? null;
      let kind = 'idle', work = null, state = null;
      if (ytId !== null) {
        kind = 'youtube';
        work = lastYoutube?.id === ytId ? lastYoutube : deps.getWorks().find((w) => w.id === ytId) ?? { id: ytId, title: '', artist: '' };
      } else {
        state = player.state();
        if (state.track) { kind = 'engine'; work = state.track; } else work = tracks[0] ?? null;
      }
      current = { kind, work };
      const key = `${kind}:${work?.id ?? ''}`;
      if (key !== shownKey) {
        shownKey = key;
        art.replaceChildren(createArtwork(document, work ?? {}, { hubAsset, className: 'mw-art rp-cover' }));
        title.textContent = work?.title || (work ? '楽曲' : '');
        shownArtist = typeof work?.artist === 'string' ? work.artist.trim() : '';
        artist.textContent = shownArtist; artist.hidden = !shownArtist;
        artist.setAttribute('aria-label', `${shownArtist}のアーティストを右列で開く`);
      }
      card.classList.toggle('is-video', kind === 'youtube');
      card.classList.toggle('is-idle', kind === 'idle');
      const playing = kind === 'youtube' || (kind === 'engine' && !state.paused);
      setIcon(toggle, playing ? 'pause' : 'play');
      toggle.setAttribute('aria-label', kind === 'youtube' ? '再生を閉じる' : playing ? '一時停止' : '再生');
      toggle.disabled = !work;
      prev.disabled = kind !== 'engine' || !state.hasPrev;
      next.disabled = kind !== 'engine' || !state.hasNext;
      seek.hidden = kind === 'youtube';
      bar.disabled = kind !== 'engine' || !(state.duration > 0);
      if (kind === 'engine') {
        bar.max = String(state.duration > 0 ? state.duration : 100);
        if (!dragging) { bar.value = String(Math.min(state.currentTime, state.duration || 100)); cur.textContent = clock(state.currentTime); }
        total.textContent = clock(state.duration);
        bar.style.setProperty('--rp-fill', `${state.duration > 0 ? Math.min(100, (state.currentTime / state.duration) * 100) : 0}%`);
      } else { bar.value = '0'; cur.textContent = '0:00'; total.textContent = '0:00'; bar.style.setProperty('--rp-fill', '0%'); }
      return state;
    }
    return { card, update };
  }

  function showList() {
    const tracks = deps.getTracks(), works = deps.getWorks();
    const quick = el(document, 'div', 'rail-music-quick');
    quick.append(button(document, 'お気に入り', () => go({ type: 'library' }), 'rail-music-chip'),
      button(document, 'プレイリスト', () => go({ type: 'playlists' }), 'rail-music-chip'));
    const body = sections(tracks, works, { moreRoute: { type: 'all' } });
    const rest = body.empty ? [deps.empty()] : body.nodes;
    if (!deps.player) { host.replaceChildren(searchForm(), quick, ...rest); return; }
    const hubFirst = [...tracks.map(trackItem), ...works.filter((w) => deps.isHubOriginalWork(w))];
    const queueSlot = el(document, 'div', 'rail-music-next');
    let queueSeen = null;
    const markCurrent = (state) => {
      const ytId = deps.youtube.active?.() ?? null;
      for (const row of host.querySelectorAll('.rail-music-item')) {
        const key = row.dataset.key ?? '';
        const on = ytId === null ? Boolean(state?.track) && key === `t:${state.track.id}` : key === `w:${ytId}`;
        row.classList.toggle('is-current', on);
      }
    };
    const paintQueue = (state) => {
      const at = state?.track ? state.queue.findIndex((t) => t.id === state.track.id) : -1;
      const list = at >= 0 ? state.queue.slice(at + 1, at + 9) : [];
      const sig = `${queueOpen}|${list.map((t) => t.id).join(',')}`;
      if (sig === queueSeen) return;
      queueSeen = sig;
      queueSlot.hidden = !queueOpen || !list.length;
      queueSlot.replaceChildren(...(queueOpen && list.length ? [heading('次に再生'), ...list.map((t) => itemRow(trackItem(t), state.queue))] : []));
    };
    const view = playerCard(hubFirst, () => { queueSeen = null; sync(); });
    function sync() { const state = view.update(); paintQueue(state); markCurrent(state); }
    host.replaceChildren(view.card, searchForm(), quick, queueSlot, ...rest);
    const stopPlayer = deps.player.subscribe(sync), stopYoutube = deps.youtube.subscribe(sync);
    unsubscribe = () => { stopPlayer?.(); stopYoutube?.(); syncPlayer = null; };
    syncPlayer = sync;
    sync();
  }

  async function showSearch(r) {
    const mine = turn;
    const status = el(document, 'p', 'meta rail-music-status', '検索しています…');
    status.setAttribute('role', 'status');
    const results = el(document, 'div', 'rail-music-results');
    host.replaceChildren(searchForm(r.query), status, results);
    try {
      const data = r.result ?? await deps.loadCatalog(r.query);
      if (mine !== turn) return;
      r.result = data;
      const body = sections(data.tracks, data.works, { moreRoute: { type: 'all', query: r.query, result: data } });
      status.textContent = body.empty ? `「${r.query}」に合う曲は見つかりませんでした。` : '';
      results.replaceChildren(...body.nodes);
    } catch {
      if (mine !== turn) return;
      status.textContent = '検索できませんでした。';
      status.append(' ', button(document, '再試行', () => { delete r.result; show(r); }, 'rail-music-link'));
    }
  }

  function showAll(r) {
    const data = r.result ?? { tracks: deps.getTracks(), works: deps.getWorks() };
    const body = sections(data.tracks, data.works, { limit: 200 });
    const list = r.section === 'external' ? body.external : body.hub;
    const title = r.section === 'external' ? 'YouTube Music' : 'Hub Music';
    host.replaceChildren(el(document, 'h3', 'rail-music-page-title', title + (r.query ? ` · 「${r.query}」` : '')),
      ...list.slice(0, 200).map((work) => itemRow(work, r.section === 'external' ? [] : list)));
  }

  function showCollection(r) {
    const mine = turn, isCurrent = current(mine);
    const slot = el(document, 'div', 'rail-music-collection');
    host.replaceChildren(slot);
    const handle = deps.collection({ host: slot, kind: r.type, name: r.name, artist: r.artist ?? '', isCurrent,
      actions: {
        playTracks: (tracks, start) => { const index = tracks.findIndex((track) => track.id === start.id); const from = index >= 200 ? index : 0; void deps.playTrack(start, tracks.slice(from, from + 200)); },
        playWork: (work) => go({ type: 'work', work, autoplay: true }),
        enqueue: (track) => deps.enqueue(track),
        openArtist: (name) => { const value = String(name ?? '').trim(); if (value) go({ type: 'artist', name: value.slice(0, 128) }); },
        openAlbum: (name, artist = '') => { const value = String(name ?? '').trim(); if (value) go({ type: 'album', name: value.slice(0, 128), artist: String(artist ?? '').trim() }); },
      } });
    disposeRoute = () => handle?.destroy?.();
  }

  function showLibrary() {
    const mine = turn, isCurrent = current(mine);
    const slot = el(document, 'div', 'rail-music-collection');
    host.replaceChildren(el(document, 'h3', 'rail-music-page-title', 'お気に入り'), slot);
    const handle = deps.library({ host: slot, isCurrent,
      actions: {
        play: (work, queue) => deps.playTrack(railTrackOf(work) ?? work, queue.map((entry) => railTrackOf(entry) ?? entry)),
        open: (work) => go({ type: 'work', work, autoplay: true }),
        enqueue: (work) => deps.enqueue(railTrackOf(work) ?? work),
      } });
    disposeRoute = () => handle?.destroy?.();
  }

  function showPlaylists() {
    const mine = turn, isCurrent = current(mine);
    const slot = el(document, 'div', 'rail-music-collection');
    host.replaceChildren(el(document, 'h3', 'rail-music-page-title', 'プレイリスト'), slot);
    const handle = deps.playlists({ host: slot, isCurrent,
      actions: { open: (item) => go({ type: 'work', work: item, autoplay: true }), play: (queue, startId) => deps.playTrack(queue.find((track) => track.id === startId) ?? queue[0], queue) } });
    disposeRoute = () => (handle?.dispose ?? handle?.destroy)?.call(handle);
  }

  // 作品ページ：公開曲はその場で再生、YouTube は右列の16:9の枠で再生。提供元のリンク（ブラウザへ出る）は置かない。
  function showWork(r) {
    const mine = turn;
    const work = r.work ?? {};
    const track = railTrackOf(work) ?? (work.kind === 'track' ? work : null);
    const source = youtubeSource(work);
    const page = el(document, 'section', 'rail-music-work');
    page.setAttribute('aria-label', '作品');
    const hero = el(document, 'div', 'rail-music-work-hero');
    hero.append(createArtwork(document, work, { hubAsset, className: 'mw-art mw-art-row' }));
    const text = el(document, 'div', 'rail-music-work-text');
    text.append(el(document, 'h3', '', work.title || '楽曲'));
    page.append(hero);
    hero.append(text, musicMenuButton(document, work, { className: 'rail-music-work-more' }));
    const links = sublinks(work);
    if (links.childNodes.length) text.append(links);
    if (work.description) page.append(el(document, 'p', 'rail-music-work-body', String(work.description)));
    const actions = el(document, 'div', 'rail-music-work-actions');
    const status = el(document, 'p', 'meta rail-music-status');
    status.setAttribute('role', 'status');
    const paint = () => {
      if (mine !== turn) return;
      actions.replaceChildren();
      if (track) {
        actions.append(button(document, '▶ 再生', () => void deps.playTrack(track, [track]), 'rail-music-chip is-primary'),
          button(document, '次に再生', () => deps.enqueue(track), 'rail-music-chip'));
      } else if (source) {
        const playing = deps.youtube.isPlaying(work.id ?? null);
        actions.append(playing
          ? button(document, '再生を閉じる', () => deps.youtube.stop(), 'rail-music-chip')
          : button(document, '▶ YouTubeで再生', () => { if (!deps.youtube.play(work, ytHost)) status.textContent = '再生を始められませんでした。'; }, 'rail-music-chip is-primary'));
      } else status.textContent = 'この作品は右列で再生できる提供元がありません。';
    };
    page.append(actions, status);
    // 公開曲のライセンスとダウンロード（許可は Music の設定。押すと Hub の作品頁をブラウザで開く）。
    if (track && HUB_TRACK.test(String(work.id ?? ''))) {
      const license = openLicenseLabel(work.license);
      if (license) {
        const line = el(document, 'p', 'meta rail-music-license', 'ライセンス：');
        const deed = licenseDeedUrl(work.license);
        if (deed && deps.openExternal) line.append(button(document, license, () => deps.openExternal(deed), 'rail-music-link', `${license}の公式の頁を開く`));
        else line.append(license);
        page.append(line);
      }
      const download = deps.download?.(work);
      if (download) {
        if (download.allowed) page.append(button(document, 'ダウンロード（Hubで開く）', () => download.open(), 'rail-music-chip'), el(document, 'p', 'meta', DOWNLOAD_WATERMARK_NOTICE));
        else page.append(el(document, 'p', 'meta', DOWNLOAD_NONE_NOTICE));
      }
    }
    // 曲のポスト（music_posts の読み取り）と、外部作品の報告。ポストは枠の下に出す。
    const postsSlot = el(document, 'div', 'rail-music-work-posts');
    const reportSlot = el(document, 'div', 'rail-music-work-report');
    const talkSlot = el(document, 'div', 'rail-music-work-talk');
    page.append(postsSlot, talkSlot, reportSlot);
    host.replaceChildren(page);
    const isCurrent = () => mine === turn;
    const posts = deps.posts?.({ host: postsSlot, work, isCurrent });
    const talk = deps.talk?.({ host: talkSlot, work, isCurrent });
    const report = deps.report?.({ host: reportSlot, work, isCurrent, open: r.report === true });
    disposeRoute = () => { posts?.destroy?.(); talk?.dispose?.(); report?.destroy?.(); };
    paint();
    if (source) unsubscribe = deps.youtube.subscribe(paint);
    if (r.autoplay && source && !deps.youtube.isPlaying(work.id ?? null)) { r.autoplay = false; deps.youtube.play(work, ytHost); }
  }

  function show(next) {
    reset();
    route = next ?? { type: 'list' };
    switch (route.type) {
      case 'search': void showSearch(route); break;
      case 'all': showAll(route); break;
      case 'artist': case 'album': showCollection(route); break;
      case 'library': showLibrary(); break;
      case 'playlists': showPlaylists(); break;
      case 'work': showWork(route); break;
      default: route = { type: 'list' }; showList();
    }
  }

  return {
    show,
    /** 一覧を読み込み直した。掘り下げは捨てて一覧に戻す。 */
    showList: () => show({ type: 'list' }),
    /** 裏の読み込みが終わった。掘り下げの途中なら触らない。 */
    refresh: () => { if (route.type === 'list') show(route); },
    route: () => route,
    /** 右列に再生中のカードがある（app.js の旧い再生札は出さない）。 */
    hasPlayer: () => Boolean(deps.player),
    /** 共有エンジンの状態が変わった。一覧のカードを更新する。 */
    syncPlayer: () => { syncPlayer?.(); },
    /** YouTube の枠が右列に置かれていて、いま見えている。 */
    hostsYoutube: () => Boolean(ytHost?.isConnected && !ytHost.hidden),
    destroy: reset,
  };
}
