// ゲーム画面の本文の部品：ライブラリのタイル、ゲームの詳細、静かな空の状態、骨組み。
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

/** ライブラリのタイル（絵・題名・補足）。entry は invoke("games") の行。open(entry) を呼ぶ。 */
export function libraryTile(document, entry, { open }) {
  const tile = el(document, 'button', 'games-tile');
  tile.type = 'button';
  tile.dataset.gameId = String(entry.id);
  tile.append(
    gameArt(document, entry, null, 'games-art-portrait'),
    el(document, 'strong', 'games-tile-title', entry.title),
    el(document, 'span', 'games-tile-meta', 'このPCに登録済み'),
  );
  tile.onclick = () => open(entry);
  return tile;
}

export function renderLibraryGrid(document, target, entries, { open }) {
  const grid = el(document, 'div', 'games-library');
  grid.append(...entries.map(entry => libraryTile(document, entry, { open })));
  target.replaceChildren(grid);
}

/** 静かな空の状態：題20/800・本文15 muted・最大1つの36pxの副ボタン。丸い飾りの絵は置かない。 */
export function renderGamesEmpty(document, target, { title, body, action }) {
  const panel = el(document, 'div', 'state-panel games-empty');
  panel.append(el(document, 'p', 'state-title', title), el(document, 'p', 'state-body', body));
  if (action) {
    const button = el(document, 'button', 'btn btn-secondary state-action', action.label);
    button.type = 'button';
    button.onclick = action.run;
    panel.append(button);
  }
  target.replaceChildren(panel);
}

export function renderLibraryEmpty(document, target, { add }) {
  renderGamesEmpty(document, target, {
    title: '登録したゲームはありません',
    body: '「ゲームを追加」から実行ファイルを選ぶと、ここから起動できます。',
    action: add ? { label: 'ゲームを追加', run: add } : null,
  });
}

/** 骨組み：最終の形で出す。文言もスピナーも出さない。 */
export function renderLibrarySkeleton(document, target, count = 6) {
  const grid = el(document, 'div', 'games-library games-skeleton-library');
  grid.setAttribute('aria-busy', 'true');
  for (let i = 0; i < count; i += 1) {
    const tile = el(document, 'div', 'games-tile games-tile-skeleton');
    tile.append(el(document, 'div', 'games-art games-art-portrait'), el(document, 'span', 'games-skeleton-line'), el(document, 'span', 'games-skeleton-line is-short'));
    grid.append(tile);
  }
  target.replaceChildren(grid);
}

function infoRow(document, label, value) {
  const row = el(document, 'div', 'games-info-row');
  row.append(el(document, 'dt', 'games-info-label', label), el(document, 'dd', 'games-info-value', value));
  return row;
}

/**
 * ゲームの詳細。kind は 'local'（このPCのゲーム）か 'store'（ストアの作品）。
 * 動作は今ある分だけ：local は 起動 / 削除、store はマーケットの商品頁（Web）で開く。back() は戻る。
 */
export function renderGameDetail(document, target, game, { kind, asset, back, launch, remove, openWeb }) {
  const page = el(document, 'article', 'games-detail');
  page.dataset.kind = kind;

  const back_ = el(document, 'button', 'games-back');
  back_.type = 'button';
  back_.setAttribute('aria-label', '戻る');
  back_.title = '戻る';
  back_.append(sidebarIcon(document, 'back'));
  back_.onclick = () => back();

  const hero = gameArt(document, game, kind === 'store' ? asset : null, 'games-art-hero');

  const meta = kind === 'store'
    ? [...game.platforms.slice(0, 4).map(gamePlatformBadge), formatGameReleaseDate(game.releaseDate), game.price].filter(Boolean)
    : ['このPCに登録済み'];
  const head = el(document, 'div', 'games-detail-head');
  const titles = el(document, 'div', 'games-detail-titles');
  titles.append(el(document, 'h3', 'games-detail-title', game.title), el(document, 'p', 'games-detail-meta', meta.join(' ・ ')));
  const actions = el(document, 'div', 'games-actions');
  if (kind === 'local') {
    const play = el(document, 'button', 'btn btn-primary', 'このPCで起動');
    play.type = 'button';
    play.onclick = () => launch(game, play);
    const del = el(document, 'button', 'btn btn-ghost', '削除');
    del.type = 'button';
    del.onclick = () => remove(game, del);
    actions.append(play, del);
  } else {
    const web = el(document, 'button', 'btn btn-primary', 'マーケットで開く');
    web.type = 'button';
    web.onclick = () => openWeb(game);
    actions.append(web);
  }
  head.append(titles, actions);

  const about = el(document, 'section', 'games-about');
  about.append(el(document, 'h4', 'games-section-title', '概要'));
  const info = el(document, 'dl', 'games-info');
  if (kind === 'store') {
    about.append(el(document, 'p', 'games-description', game.summary || '説明はまだありません。'));
    if (game.platforms.length) info.append(infoRow(document, '機種', game.platforms.map(gamePlatformBadge).join('、')));
    const date = formatGameReleaseDate(game.releaseDate);
    if (date) info.append(infoRow(document, '発売日', date));
    if (game.price) info.append(infoRow(document, '価格', game.price));
  } else {
    about.append(el(document, 'p', 'games-description', 'このPCの実行ファイルから起動します。一覧から外してもゲーム本体は削除されません。'));
    if (game.executablePath) info.append(infoRow(document, '実行ファイル', game.executablePath));
  }
  page.append(back_, hero, head, about);
  if (info.childElementCount) page.append(info);
  target.replaceChildren(page);
}
