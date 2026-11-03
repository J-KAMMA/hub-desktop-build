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
 *  youtube: {play(work, panel), stop(), isPlaying(workId), subscribe(fn)}   共有の YouTube 枠
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

  // 1曲1行：押すとその場で再生（公開曲は音声、YouTube は右列の枠）。⋯ に曲の操作が入る。アーティストへの移動は作品の見出しの名前から。
  function itemRow(work, queue) {
    const item = el(document, 'div', 'rail-music-item');
    const track = railTrackOf(work) ?? (work.kind === 'track' ? work : null);
    const open = track
      ? () => void deps.playTrack(track, queue.map((entry) => railTrackOf(entry) ?? entry))
      : () => go({ type: 'work', work, autoplay: true });
    item.append(railRow(document, { title: work.title || '楽曲', text: work.artist || '', avatar: railAvatar(document, { icon: 'music' }), onOpen: open }));
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

  function showList() {
    const tracks = deps.getTracks(), works = deps.getWorks();
    const quick = el(document, 'div', 'rail-music-quick');
    quick.append(button(document, 'お気に入り', () => go({ type: 'library' }), 'rail-music-chip'),
      button(document, 'プレイリスト', () => go({ type: 'playlists' }), 'rail-music-chip'));
    const body = sections(tracks, works, { moreRoute: { type: 'all' } });
    host.replaceChildren(searchForm(), quick, ...(body.empty ? [deps.empty()] : body.nodes));
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
    page.append(postsSlot, reportSlot);
    host.replaceChildren(page);
    const isCurrent = () => mine === turn;
    const posts = deps.posts?.({ host: postsSlot, work, isCurrent });
    const report = deps.report?.({ host: reportSlot, work, isCurrent, open: r.report === true });
    disposeRoute = () => { posts?.destroy?.(); report?.destroy?.(); };
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
    /** YouTube の枠が右列に置かれていて、いま見えている。 */
    hostsYoutube: () => Boolean(ytHost?.isConnected && !ytHost.hidden),
    destroy: reset,
  };
}
