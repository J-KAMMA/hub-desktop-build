// 記事のホーム：注目の1行 + 記事の行（2026-11-02）。
// 行は線で区切る（箱にしない）。サムネイルは右に 120×80、注目の行だけ 240×160。
// 画像は許可された出どころだけ（createCoverMedia が検査し、読めなければ題を組んだ表紙にする）。新しい読み取りは足さない。
// 空の状態：題 20/800・本文 15 muted・ボタンは多くて1つ（36px の副ボタン）・記号の円盤なし。
import { createCoverMedia } from './media-image.mjs';
import { articleReadingMinutes } from './article-reading.mjs';

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const text = value => (typeof value === 'string' ? value.trim() : '');

/** 一覧の1件の表示用の形。id が無い項目は開けない。 */
export function articleRowModel(article, { relTime = () => '' } = {}) {
  const tags = (Array.isArray(article?.tags) ? article.tags : []).filter(tag => typeof tag === 'string' && tag.trim());
  const title = text(article?.title) || '（題未設定）';
  return {
    id: typeof article?.id === 'string' && article.id ? article.id : '',
    title,
    summary: text(article?.summary),
    thumbnailUrl: typeof article?.thumbnailUrl === 'string' ? article.thumbnailUrl : '',
    author: text(article?.authorName) || text(article?.author),
    when: relTime(article?.createdAt ?? article?.publishedAt) || '',
    // 読了時間：一覧が本文を持たないときは出さない（作らない）。
    reading: (() => { const given = Number(article?.readingMinutes); const minutes = given > 0 ? Math.ceil(given) : typeof article?.body === 'string' ? articleReadingMinutes(article.body) : 0; return minutes > 0 ? `約${minutes}分` : ''; })(),
    tag: tags[0] ? tags[0].trim() : '',
    coverLabel: tags[0] ? tags[0].trim() : Array.from(title)[0] || '記事',
  };
}

/** 注目に選ぶのは、サムネイルのある最初の記事。無ければ先頭。 */
export function pickFeatured(items) {
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex(item => typeof item?.thumbnailUrl === 'string' && item.thumbnailUrl);
  return index >= 0 ? index : list.length ? 0 : -1;
}

/** 記事の1行。featured なら大きい行。onOpen(article) は id のある行だけ。 */
export function renderArticleRow(document, article, { hubAsset, hubOrigin = '', relTime, onOpen, featured = false } = {}) {
  const view = articleRowModel(article, { relTime });
  const row = el(document, 'article', `ar-row${featured ? ' ar-featured' : ''}`);
  row.dataset.articleId = view.id;
  row.setAttribute('role', 'listitem');
  const body = el(document, 'div', 'ar-body');
  body.append(el(document, 'strong', 'ar-title', view.title));
  if (view.summary) body.append(el(document, 'p', 'ar-summary', view.summary));
  // 2026-11-05 所有者「ポスト以外もこの形式」：タグは時刻の横の小さな札。
  const meta = [view.author, view.when, view.reading].filter(Boolean).join(' · ');
  if (meta || view.tag) {
    const line = el(document, 'p', 'ar-meta', meta);
    if (view.tag) line.append(el(document, 'span', 'post-tag', `#${view.tag}`));
    body.append(line);
  }
  const thumb = createCoverMedia(document, { url: view.thumbnailUrl, title: view.title, fallbackLabel: view.coverLabel, hubAsset, hubOrigin, ratio: '3 / 2', className: 'ar-thumb' });
  row.append(body, thumb);
  if (view.id && onOpen) {
    row.classList.add('is-link');
    row.tabIndex = 0;
    row.title = '開く';
    row.onclick = () => onOpen(article);
    row.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); onOpen(article); } };
  }
  return row;
}

/** ホーム：先頭に注目の1行、続けて残りの行。items が空なら null（空の状態は呼ぶ側が出す）。 */
export function renderArticleHome(document, items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const featuredIndex = pickFeatured(list);
  const root = el(document, 'div', 'ar-home');
  root.setAttribute('role', 'list');
  root.setAttribute('aria-label', '記事');
  root.append(renderArticleRow(document, list[featuredIndex], { ...options, featured: true }));
  list.forEach((item, index) => { if (index !== featuredIndex) root.append(renderArticleRow(document, item, options)); });
  return root;
}

/**
 * 空の状態の文。kind: 'none'（記事がまだ無い）/ 'filtered'（検索・分類で0件）/ 'drafts' / 'saved' / 'tag'。
 * action は { label, run } か null（ボタンは多くて1つ）。run は呼ぶ側が渡す。
 */
export function articleEmptyCopy(kind, { actions = {} } = {}) {
  const copy = {
    none: { title: '記事はまだありません', body: '最初の記事を書くと、ここに並びます。', action: actions.write ? { label: '記事を書く', run: actions.write } : null },
    filtered: { title: '条件に一致する記事がありません', body: '検索語や分類を変えてみてください。', action: actions.clear ? { label: '絞り込みを解除', run: actions.clear } : null },
    drafts: { title: '下書きはありません', body: '書きかけの記事は、ここから続きを書けます。', action: actions.write ? { label: '記事を書く', run: actions.write } : null },
    saved: { title: '保存した記事はありません', body: '記事を保存すると、ここにまとまります。', action: null },
    tag: { title: 'このタグの記事はまだありません', body: '別のタグか、ホームの記事を見てみてください。', action: actions.home ? { label: 'ホームへ', run: actions.home } : null },
  };
  return copy[kind] ?? copy.none;
}

/** 空の状態の要素。記号の円盤は置かない。 */
export function renderArticleEmpty(document, kind, options = {}) {
  const copy = articleEmptyCopy(kind, options);
  const box = el(document, 'div', 'ar-empty');
  box.setAttribute('role', 'status');
  box.append(el(document, 'strong', 'ar-empty-title', copy.title), el(document, 'p', 'ar-empty-body', copy.body));
  if (copy.action) {
    const button = el(document, 'button', 'btn btn-secondary ar-empty-action', copy.action.label);
    button.type = 'button';
    button.onclick = copy.action.run;
    box.append(button);
  }
  return box;
}
