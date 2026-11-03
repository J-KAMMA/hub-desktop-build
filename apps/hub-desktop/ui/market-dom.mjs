// マーケット画面の小さな部品（要素を作る・絵・静かな空の状態・骨組み）。読み込みも保存もしない。
import { initialOf } from './market-model.mjs';

export function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null && text !== '') node.textContent = text;
  return node;
}

export function button(document, label, className, onClick) {
  const node = el(document, 'button', className, label);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

/** 正方形の絵。画像が無い・読めないときは販売者（無ければ題）の頭字。asset(img, url) は app.js の hubAsset。 */
export function media(document, { url, label, alt, asset, className = 'mk-media' }) {
  const box = el(document, 'span', className);
  const letter = el(document, 'span', 'mk-media-letter', initialOf(label));
  letter.setAttribute('aria-hidden', 'true');
  box.append(letter);
  if (url) {
    const img = document.createElement('img');
    img.alt = alt ?? '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.remove());
    if (typeof asset === 'function') asset(img, url); else img.src = url;
    box.append(img);
  }
  return box;
}

/** 静かな空の状態：題20/800・本文15 muted・副ボタンは1つまで。丸い飾りは置かない。 */
export function emptyState(document, { title, body, actionLabel, onAction, role }) {
  const box = el(document, 'div', 'mk-empty');
  if (role) box.setAttribute('role', role);
  box.append(el(document, 'p', 'mk-empty-title', title));
  if (body) box.append(el(document, 'p', 'mk-empty-body', body));
  if (actionLabel && onAction) box.append(button(document, actionLabel, 'mk-btn', onAction));
  return box;
}

/** 完成形と同じ形の骨組み（正方形・題2行・価格・販売者）。 */
export function skeletonTile(document) {
  const tile = el(document, 'div', 'mk-tile mk-skeleton');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el(document, 'span', 'mk-media mk-skel'));
  const lines = el(document, 'span', 'mk-tile-body');
  for (const cls of ['mk-skel-line', 'mk-skel-line is-short', 'mk-skel-line is-price', 'mk-skel-line is-seller']) lines.append(el(document, 'span', `mk-skel ${cls}`));
  tile.append(lines);
  return tile;
}

export function badge(document, text) {
  return el(document, 'span', 'mk-badge', text);
}
