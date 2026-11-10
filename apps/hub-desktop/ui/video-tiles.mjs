// 動画の棚・空の状態の部品（2026-11-02、デスクトップ仕様 §3.4 と DESIGN-SYSTEM のメディアタイル／状態）。
// 札そのもの（createVideoCard）と骨組み（createVideoSkeletons）は video-home.mjs。ここは棚の枠と、静かな空の状態だけ。
// 空の状態：題20/800・本文15の淡色（最大360）・副ボタンは多くて1つ・丸い絵柄は置かない。読み込み中の文は出さない（骨組みを使う）。

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 画面ごとの空の状態の文言。action があるときだけボタンを1つ出す（行き先は呼び出し側）。 */
export const VIDEO_EMPTY = Object.freeze({
  home: Object.freeze({ title: '動画はまだありません', body: '検索語やカテゴリを変えるか、Webで探してください。' }),
  filtered: Object.freeze({ title: '条件に一致する動画はありません', body: '検索語やカテゴリ、表示順を変えてみてください。' }),
  shorts: Object.freeze({ title: '60秒以下の動画はまだありません', body: '読み込んだ動画のうち、長さが60秒以下のものをここに並べます。' }),
  subscriptions: Object.freeze({ title: 'フォロー中の新着はまだありません', body: '動画を投稿する人をフォローすると、新しい動画がここに並びます。' }),
  history: Object.freeze({ title: '見た動画はまだありません', body: 'この起動中に見た動画がここに並びます。端末には残しません。' }),
  later: Object.freeze({ title: 'あとで見る動画はありません', body: '動画の画面で保存すると、ここに並びます。' }),
  playlists: Object.freeze({ title: '再生リストはまだありません', body: '動画をまとめると、ここに並びます。' }),
  error: Object.freeze({ title: '読み込めませんでした', body: '通信を確かめて、もう一度お試しください。', action: 'もう一度' }),
});

/** 表示モードと状態から、空の状態の文言を選ぶ。 */
export function emptyFor({ mode = 'home', failed = false, filtered = false } = {}) {
  if (failed) return VIDEO_EMPTY.error;
  if (mode === 'home') return filtered ? VIDEO_EMPTY.filtered : VIDEO_EMPTY.home;
  return VIDEO_EMPTY[mode] ?? VIDEO_EMPTY.home;
}

/** 静かな空の状態。spec は {title, body, action?}。action があれば副ボタンを1つだけ（onAction で動く）。 */
export function createVideoEmpty(document, spec, { onAction = null } = {}) {
  const box = el(document, 'div', 'vt-empty');
  box.setAttribute('role', 'status');
  box.append(el(document, 'strong', 'vt-empty-title', spec.title));
  // 説明は字で見せない：短い一言だけ残し、長い文・生のエラーはtitle属性へ。
  if (spec.body && String(spec.body).length <= 12) box.append(el(document, 'p', 'vt-empty-body', spec.body));
  else if (spec.body) box.title = String(spec.body);
  if (spec.action && typeof onAction === 'function') {
    const button = el(document, 'button', 'vt-empty-action', spec.action);
    button.type = 'button';
    button.onclick = () => onAction();
    box.append(button);
  }
  return box;
}

/** 棚：見出しと、16:9 の札の格子。札は呼び出し側が作る（createVideoCard / createVideoSkeletons）。 */
export function createVideoShelf(document, title, nodes, { skeleton = false } = {}) {
  const section = el(document, 'section', `vt-shelf${skeleton ? ' is-loading' : ''}`);
  if (title) section.setAttribute('aria-label', title);
  const grid = el(document, 'div', 'vt-grid');
  grid.append(...nodes);
  if (title) section.append(el(document, 'h3', 'vt-shelf-title', title));
  section.append(grid);
  return section;
}
