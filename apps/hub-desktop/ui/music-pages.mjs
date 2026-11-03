// 音楽のプレイリストの頁とアーティスト一覧の頁（2026-11-02）。
// プレイリスト：頭に表紙・題・曲数、再生とシャッフル、その下に番号つきの行（# / 題とアーティスト / 時間 / ⋯）。
// 再生できるのは Hub の公開曲（既存の再生経路）と YouTube の埋め込みだけ。購入の操作は置かない。
import { createArtwork, youtubeSource } from './music-youtube.mjs';
import { filterWorks } from './yt-unplayable.mjs';
import { musicMenuButton } from './music-track-menu.mjs';

const HUB_TRACK = /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function timeLabel(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 並びをシャッフルする。乱数は呼び出し側から渡せる（テスト用）。元の配列は変えない。 */
export function shuffled(list, random = Math.random) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

const trackOf = work => ({ ...work, id: work.id.slice(6) });

/**
 * @param playlist  { id, title, description, items: [workId...] }
 * @param resolve   (workId) => Promise<work|null>。見つからなければ null（行は題なしの静かな行になる）
 * @param actions   { playTracks(tracks, start), playWork(work), enqueue(track), openArtist(name), edit() }
 */
export function renderMusicPlaylist({ document, host, playlist, resolve, hubAsset, actions, random = Math.random, isCurrent = () => true }) {
  const root = el(document, 'section', 'mp');
  root.setAttribute('aria-label', `プレイリスト ${playlist.title}`);
  host.append(root);
  let works = playlist.items.map(id => ({ id, pending: true }));
  let disposed = false;
  const live = () => !disposed && root.isConnected && isCurrent();
  const hubWorks = () => works.filter(work => !work.pending && !work.missing && HUB_TRACK.test(work.id));

  const hero = el(document, 'div', 'mw-hero mc-hero');
  const cover = el(document, 'div', 'mp-cover');
  const text = el(document, 'div', 'mw-hero-text');
  const title = el(document, 'h2', 'mw-title', playlist.title);
  const meta = el(document, 'p', 'mw-credits', '');
  const bar = el(document, 'div', 'mw-actions');
  const playAll = el(document, 'button', 'mw-play', '▶');
  playAll.type = 'button'; playAll.setAttribute('aria-label', `${playlist.title}を再生`);
  const shuffle = el(document, 'button', 'head-action mp-shuffle', 'シャッフル');
  shuffle.type = 'button';
  bar.append(playAll, shuffle);
  if (actions.edit) {
    const edit = el(document, 'button', 'head-action mp-edit', '編集');
    edit.type = 'button'; edit.onclick = () => live() && actions.edit();
    bar.append(edit);
  }
  text.append(el(document, 'span', 'mw-kind', 'プレイリスト'), title);
  if (playlist.description) text.append(el(document, 'p', 'mw-description', playlist.description));
  text.append(meta, bar);
  hero.append(cover, text);
  const list = el(document, 'ol', 'mc-tracks mp-rows');
  list.setAttribute('aria-label', `${playlist.title}の曲`);
  const headRow = el(document, 'li', 'mp-head');
  headRow.setAttribute('aria-hidden', 'true');
  headRow.append(el(document, 'span', 'mc-no', '#'), el(document, 'span', '', '曲'), el(document, 'span', 'mp-time', '時間'), el(document, 'span', ''));
  const empty = el(document, 'p', 'meta mc-empty', 'この曲の入っていないプレイリストです。曲の詳細から追加できます。');
  root.append(hero, list);

  function play(queue, start) {
    if (!live() || !queue.length) return;
    actions.playTracks(queue.map(trackOf), trackOf(start));
  }
  playAll.onclick = () => {
    const queue = hubWorks();
    if (queue.length) return play(queue, queue[0]);
    const first = works.find(work => !work.pending && !work.missing && youtubeSource(work));
    if (first && live()) actions.playWork(first);
  };
  shuffle.onclick = () => { const queue = shuffled(hubWorks(), random); if (queue.length) play(queue, queue[0]); };

  function paint() {
    const known = works.filter(work => !work.pending);
    const playable = hubWorks().length > 0 || works.some(work => !work.pending && !work.missing && youtubeSource(work));
    playAll.disabled = !playable;
    shuffle.disabled = hubWorks().length === 0;
    const total = works.reduce((sum, work) => sum + (Number(work.durationSeconds) > 0 ? Number(work.durationSeconds) : 0), 0);
    meta.textContent = `${works.length}曲${total ? ` · ${timeLabel(total)}` : ''}`;
    cover.replaceChildren(createArtwork(document, known.find(work => !work.missing) ?? { title: playlist.title }, { hubAsset, className: 'mw-art mw-art-hero mc-cover' }));
    const rows = [];
    works.forEach((work, index) => {
      const item = el(document, 'li', 'mc-track mp-row');
      item.dataset.workId = work.id;
      item.append(el(document, 'b', 'mc-no', String(index + 1)));
      const copy = el(document, 'span', 'mc-text mp-text');
      if (work.pending || work.missing) {
        copy.append(el(document, 'span', 'mc-sub', work.pending ? '読み込んでいます…' : '公開情報を取得できない作品'));
      } else {
        const name = el(document, 'button', 'mc-title', work.title);
        name.type = 'button';
        const isHub = HUB_TRACK.test(work.id);
        name.setAttribute('aria-label', `${work.title}を再生`);
        name.onclick = () => { if (!live()) return; if (isHub) play(hubWorks(), work); else actions.playWork(work); };
        const sub = el(document, 'span', 'mc-sub');
        if (work.artist) {
          const artist = el(document, 'button', 'mc-link', work.artist);
          artist.type = 'button'; artist.onclick = () => live() && actions.openArtist?.(work.artist);
          sub.append(artist);
        }
        copy.append(name, sub);
      }
      item.append(copy, el(document, 'span', 'mp-time', work.pending || work.missing ? '' : timeLabel(work.durationSeconds ?? work.duration)));
      const more = musicMenuButton(document, work, { className: 'mp-more' });
      more.disabled = work.pending === true || work.missing === true;
      item.append(more);
      rows.push(item);
    });
    list.replaceChildren(...(rows.length ? [headRow, ...rows] : []));
    if (!rows.length) root.append(empty); else empty.remove();
  }

  paint();
  const ready = (async () => {
    const resolved = await Promise.all(playlist.items.map(async id => { try { return (await resolve(id)) ?? { id, missing: true }; } catch { return { id, missing: true }; } }));
    if (disposed) return;
    works = filterWorks(resolved.map((work, index) => (work.missing ? { id: playlist.items[index], missing: true } : { ...work, id: work.id ?? playlist.items[index] })));
    paint();
  })();
  return { root, ready, destroy() { disposed = true; root.remove(); } };
}

/**
 * アーティスト一覧：曲を持つアーティストを四角い札で。押すとそのアーティストの頁へ。
 * @param works  目録の曲・作品（artist を持つもの）。曲数の多い順（同数は名前順）で安定させる。
 */
export function artistTiles(works) {
  const map = new Map();
  for (const work of works) {
    const name = typeof work?.artist === 'string' ? work.artist.normalize('NFKC').trim() : '';
    if (!name) continue;
    const key = name.toLocaleLowerCase('ja-JP');
    const entry = map.get(key) ?? { name, count: 0, cover: work };
    entry.count++;
    if (!entry.cover.artworkUrl && work.artworkUrl) entry.cover = work;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
}

export function renderMusicArtists({ document, host, load, hubAsset, actions, isCurrent = () => true }) {
  const root = el(document, 'section', 'mp mp-artists');
  root.setAttribute('aria-label', 'アーティスト');
  host.append(root);
  let disposed = false;
  const heading = el(document, 'h2', 'mw-title', 'アーティスト');
  const status = el(document, 'p', 'meta mc-status', '読み込んでいます…');
  status.setAttribute('role', 'status');
  const grid = el(document, 'div', 'mp-artist-grid');
  grid.setAttribute('role', 'list');
  root.append(heading, status, grid);
  const ready = (async () => {
    let works = [];
    let failed = false;
    try { works = filterWorks(await load()); } catch { failed = true; }
    if (disposed || !root.isConnected || !isCurrent()) return;
    const tiles = artistTiles(Array.isArray(works) ? works : []);
    status.textContent = tiles.length ? '' : failed ? 'アーティストを読み込めませんでした。' : 'アーティストはまだいません。';
    grid.replaceChildren(...tiles.map(tile => {
      const card = el(document, 'article', 'mh-card mp-artist');
      card.setAttribute('role', 'listitem');
      const button = el(document, 'button', 'mh-card-open');
      button.type = 'button';
      button.setAttribute('aria-label', `${tile.name}のアーティストページを開く`);
      button.append(createArtwork(document, tile.cover, { hubAsset, className: 'mw-art mw-art-card mp-artist-art' }), el(document, 'strong', 'mh-card-title', tile.name), el(document, 'span', 'mh-card-artist', `${tile.count}曲`));
      button.onclick = () => { if (!disposed && isCurrent()) actions.openArtist(tile.name); };
      card.append(button);
      return card;
    }));
  })();
  return { root, ready, destroy() { disposed = true; root.remove(); } };
}
