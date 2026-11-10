// ゲームの本文の部品：ストア作品の詳細と絵。このPCに登録するランチャーは無い（2026-11-04）。
// 枠のカードは使わない。絵のタイルが半径を持ち、一覧は線で区切る。
import { sidebarIcon } from './sidebar-media.mjs';
import { gamePlatformBadge, formatGameReleaseDate } from './games-view.mjs';

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 絵が無いときの頭字（タイトルの最初の1文字）。 */
export function gameInitial(title) {
  const first = [...String(title ?? '').trim()][0];
  return first ? first.toUpperCase() : '?';
}

/** 絵：画像があれば asset(img, url)、無い（読めない）ときは頭字。 */
export function gameArt(document, game, asset, className) {
  const art = el(document, 'div', `games-art ${className ?? ''}`.trim());
  const letter = el(document, 'span', 'games-art-letter', gameInitial(game.title));
  art.append(letter);
  if (game.imageUrl && typeof asset === 'function') {
    const img = el(document, 'img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove(), { once: true });
    asset(img, game.imageUrl);
    art.append(img);
  }
  return art;
}

function infoRow(document, label, value) {
  const row = el(document, 'div', 'games-info-row');
  row.append(el(document, 'dt', 'games-info-label', label), el(document, 'dd', 'games-info-value', value));
  return row;
}

/**
 * ストア作品の詳細。動作はマーケットの商品頁（Web）で開くだけ。back() は戻る。
 */
export function renderGameDetail(document, target, game, { asset, back, openWeb }) {
  const page = el(document, 'article', 'games-detail');
  page.dataset.kind = 'store';

  const back_ = el(document, 'button', 'games-back');
  back_.type = 'button';
  back_.setAttribute('aria-label', '戻る');
  back_.title = '戻る';
  back_.append(sidebarIcon(document, 'back'));
  back_.onclick = () => back();

  const hero = gameArt(document, game, asset, 'games-art-hero');

  const meta = [...game.platforms.slice(0, 4).map(gamePlatformBadge), formatGameReleaseDate(game.releaseDate), game.price].filter(Boolean);
  const head = el(document, 'div', 'games-detail-head');
  const titles = el(document, 'div', 'games-detail-titles');
  titles.append(el(document, 'h3', 'games-detail-title', game.title), el(document, 'p', 'games-detail-meta', meta.join(' ・ ')));
  const actions = el(document, 'div', 'games-actions');
  const web = el(document, 'button', 'btn btn-primary', 'マーケットで開く');
  web.type = 'button';
  web.onclick = () => openWeb(game);
  actions.append(web);
  head.append(titles, actions);

  const about = el(document, 'section', 'games-about');
  about.append(el(document, 'h4', 'games-section-title', '概要'));
  const info = el(document, 'dl', 'games-info');
  about.append(el(document, 'p', 'games-description', game.summary || '説明はまだありません。'));
  if (game.platforms.length) info.append(infoRow(document, '機種', game.platforms.map(gamePlatformBadge).join('、')));
  const date = formatGameReleaseDate(game.releaseDate);
  if (date) info.append(infoRow(document, '発売日', date));
  if (game.price) info.append(infoRow(document, '価格', game.price));
  page.append(back_, hero, head, about);
  if (info.childElementCount) page.append(info);
  target.replaceChildren(page);
}
