// 音楽作品の詳細：大きなジャケット、題名、操作の列、YouTube の再生パネル。
// 購入・決済の操作は置かない。
import { youtubeSource, openLinks, createArtwork } from './music-youtube.mjs';
import { licenseDeedUrl, openLicenseLabel } from './content-license.mjs';
import { DOWNLOAD_NONE_NOTICE, DOWNLOAD_WATERMARK_NOTICE } from './content-download.mjs';

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * @param work        作品（title, artist, album, year, genre, description, services）
 * @param session     createMusicYoutubeSession の戻り値
 * @param openExternal  提供元のリンクを Hub のブラウザで開く
 * @param local       Music Worker の公開曲なら { play(), next() }。YouTube 以外のアプリ内再生はこれだけ。
 * @param autoplay    一覧の再生ボタンから来たとき true（押された直後の1回だけ）
 * @param download    公開曲のダウンロード { allowed, open() }。許可は Music の設定で、押すとHubの作品頁を開く。
 */
export function renderMusicWorkHeader({ document, work, session, hubAsset, openExternal, local = null, autoplay = false, download = null, onOpenArtist = null, onOpenAlbum = null }) {
  const root = el(document, 'div', 'mw-detail');
  const hero = el(document, 'div', 'mw-hero');
  const text = el(document, 'div', 'mw-hero-text');
  const credits = [work.artist, work.year, work.genre].filter(value => value !== undefined && value !== null && value !== '').join(' · ');
  text.append(
    el(document, 'span', 'mw-kind', local ? 'Hub公開曲' : '楽曲'),
    el(document, 'h2', 'mw-title', work.title || '楽曲'),
    el(document, 'p', 'mw-credits', credits),
  );
  if (work.album) text.append(el(document, 'p', 'mw-credits mw-album', work.album));
  // アーティスト・アルバムの頁へ（Web と同じ入口）。
  if ((onOpenArtist && work.artist) || (onOpenAlbum && work.album)) {
    const links = el(document, 'div', 'mw-links');
    if (onOpenArtist && work.artist) { const artist = el(document, 'button', 'head-action', work.artist + 'のページ'); artist.type = 'button'; artist.onclick = () => onOpenArtist(work.artist); links.append(artist); }
    if (onOpenAlbum && work.album) { const album = el(document, 'button', 'head-action', 'アルバム「' + work.album + '」'); album.type = 'button'; album.onclick = () => onOpenAlbum(work.album, work.artist ?? ''); links.append(album); }
    text.append(links);
  }
  if (work.description) text.append(el(document, 'p', 'mw-description', work.description));
  // ライセンスはHubの公開曲だけ（YouTubeなど外部の作品には付けない）。CCのときだけ公式の頁へのリンクを添える。
  const licenseLabel = local ? openLicenseLabel(work.license) : null;
  if (licenseLabel) {
    const line = el(document, 'p', 'meta mw-license', 'ライセンス：');
    const deed = licenseDeedUrl(work.license);
    if (deed) {
      const link = el(document, 'button', 'head-action mw-link', licenseLabel);
      link.type = 'button';
      link.onclick = () => openExternal(deed);
      line.append(link);
    } else line.append(licenseLabel);
    text.append(line);
  }
  hero.append(createArtwork(document, work, { hubAsset, className: 'mw-art mw-art-hero' }), text);

  const playable = youtubeSource(work);
  const actions = el(document, 'div', 'mw-actions');
  const play = el(document, 'button', 'mw-play');
  play.type = 'button';
  const note = el(document, 'span', 'mw-play-note');
  note.setAttribute('role', 'status');
  const panel = el(document, 'div', 'mw-player-panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'YouTubeプレーヤー');

  const paint = () => {
    const playing = playable !== null && session.isPlaying(work.id ?? null);
    play.textContent = playing ? '■' : '▶';
    play.setAttribute('aria-label', playing ? '再生を止める' : '再生');
    play.setAttribute('aria-pressed', String(playing));
    play.title = playing ? '再生を止める' : '再生';
    if (!playable && !local) { play.disabled = true; note.textContent = 'この作品はHub内では再生できません。下の提供元で開けます。'; }
    else { play.disabled = false; note.textContent = ''; }
  };
  let seen = false;
  play.onclick = () => {
    if (local) { void local.play(); return; }
    if (!playable) return;
    if (session.isPlaying(work.id ?? null)) { session.stop(); return; }
    if (!session.play({ work, panel })) note.textContent = '再生を始められませんでした。';
  };
  const unsubscribe = session.subscribe(() => {
    if (root.isConnected) seen = true;
    else if (seen) { unsubscribe(); return; }
    paint();
  });
  paint();
  actions.append(play, note);
  if (local?.next) {
    const next = el(document, 'button', 'head-action', '次に再生');
    next.type = 'button';
    next.onclick = () => local.next();
    actions.append(next);
  }

  // ダウンロードは公開曲だけ。許可されていなければ、再生はできることと録画は防げないことを書く。
  let downloadRow = null;
  if (local && download) {
    downloadRow = el(document, 'div', 'mw-links');
    if (download.allowed) {
      const button = el(document, 'button', 'head-action mw-link', 'ダウンロード（Hubで開く）');
      button.type = 'button';
      button.onclick = () => download.open();
      downloadRow.append(button, el(document, 'p', 'meta', DOWNLOAD_WATERMARK_NOTICE));
    } else downloadRow.append(el(document, 'p', 'meta', DOWNLOAD_NONE_NOTICE));
  }

  const links = openLinks(work, playable);
  let linkRow = null;
  if (links.length) {
    linkRow = el(document, 'div', 'mw-links');
    for (const link of links) {
      const button = el(document, 'button', 'head-action mw-link', link.label);
      button.type = 'button';
      button.onclick = () => openExternal(link.url);
      linkRow.append(button);
    }
  } else if (!playable && !local) {
    linkRow = el(document, 'p', 'meta', '外部の提供先がまだ登録されていません。');
  }

  root.append(hero, actions, panel);
  if (downloadRow) root.append(downloadRow);
  if (linkRow) root.append(linkRow);
  if (autoplay && playable && !session.isPlaying(work.id ?? null)) session.play({ work, panel });
  else if (playable && session.isPlaying(work.id ?? null)) session.reattach?.({ work, panel });
  return { root, actions, panel, playButton: play, destroy: () => { unsubscribe(); } };
}
