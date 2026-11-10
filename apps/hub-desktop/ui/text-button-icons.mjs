// 2026-11-04 所有者承認：Hub Desktop のボタンは字をやめて記号にする。名前は aria-label と title に残す。
// 字のまま残すのは購入・支払い・送信/投稿・削除・同意・サインイン/連携・法令/安全のボタンと、全幅の行（「続きを表示」など）。
// ここに載せた字と完全に一致する子なしのボタンだけを置き換える。載せていない字は触らない。
const NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5 8 12l7 7',
  forward: 'M9 5l7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  refresh: 'M19 8a8 8 0 0 0-14 2M5 4v6h6M5 16a8 8 0 0 0 14-2M19 20v-6h-6',
  edit: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.9.5l-2.9.8a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9Z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v7h14v-7',
  list: 'M5 6h14M5 12h14M5 18h9',
  later: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  drafts: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  saved: 'M7 4h10v16l-5-3.5L7 20z',
  readAll: 'M3 12.5 7.5 17 15 8.5M12 16.5l1 .5 8-9',
  follow: 'M10 11.5a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM3.5 19.5a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6',
  following: 'M10 11.5a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM3.5 19.5a6.5 6.5 0 0 1 13 0M16 11.5l2 2 3.5-4',
  clear: 'M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7',
  filter: 'M4 5h16l-6 7.5V19l-4-2v-4.5z',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  latest: 'M12 5v14M6 13l6 6 6-6',
};
// 2026-11-05 所有者「一般的じゃないアイコンはアイコンと文字のほうがわかりやすい」：誰でも読める記号
// （閉じる・戻る・更新・編集・コピー・共有・検索・追加・お気に入り）以外は、記号の横に名前を添える。
export const ICON_ONLY = new Set(['close', 'back', 'refresh', 'edit', 'copy', 'share', 'search', 'plus', 'heart']);
// 字 → [記号, 名前, 押下状態（トグルのみ）]
export const TEXT_TO_ICON = new Map([
  ['閉じる', ['close']], ['戻る', ['back']], ['← 戻る', ['back', '戻る']], ['← 動画一覧へ', ['back', '動画一覧へ']],
  ['更新', ['refresh']], ['候補を再検出', ['refresh']],
  ['編集', ['edit']], ['コピー', ['copy']], ['共有', ['share']], ['開く', ['open']],
  ['すべて見る', ['forward']],
  ['＋作成', ['plus', '作成']], ['＋ 新規', ['plus', '新規']], ['＋ 新しい作業', ['plus', '新しい作業']], ['新規作成', ['plus']],
  ['検索', ['search']], ['追加', ['plus']], ['新しいメッセージ', ['plus']], ['もう一度', ['refresh']], ['絞り込み', ['filter']], ['並べ替え', ['list']],
  ['プレイリスト', ['list']], ['あとで見る', ['later']], ['お気に入り', ['heart']],
  ['保存した記事', ['saved']], ['下書き', ['drafts']], ['すべて既読', ['readAll']],
  ['全スレッド', ['clear']], ['最新へ ↓', ['latest', '最新へ']],
  ['フォロー', ['follow', 'フォロー', false]], ['フォローする', ['follow', 'フォロー', false]], ['タグをフォロー', ['follow', 'タグをフォロー', false]],
  ['フォロー中', ['following', 'フォロー中', true]],
]);
// 字のまま残す囲い（法令・安全・同意など）。
const KEEP = '[data-keep-text], [data-legal], .legal, .consent, [role="alertdialog"]';

export function iconSvg(document, name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic txt-icon-svg');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}

export function iconifyButton(button) {
  if (!button || button.localName !== 'button' || button.children.length || button.closest?.(KEEP)) return false;
  // タブは並びの中で字のまま読む（2026-11-05 所有者「フォロー中文字の方がいい」）。
  if (button.getAttribute?.('role') === 'tab') return false;
  const text = button.textContent.trim();
  const hit = TEXT_TO_ICON.get(text);
  if (!hit) return false;
  const [icon, name = text, pressed] = hit;
  // 文字が替わる切り替え（フォロー → フォロー中）でも、こちらが付けた名前と押下の状態を追わせる。
  const ours = button.getAttribute('data-text-icon') === '1';
  if (ours || !button.getAttribute('aria-label')) button.setAttribute('aria-label', name);
  if (ours || !button.title) button.title = name;
  if (pressed !== undefined && (ours || !button.hasAttribute('aria-pressed'))) button.setAttribute('aria-pressed', String(pressed));
  button.setAttribute('data-text-icon', '1');
  button.classList.add('is-text-icon');
  if (ICON_ONLY.has(icon)) { button.replaceChildren(iconSvg(button.ownerDocument, icon)); return true; }
  button.classList.add('is-text-icon-labeled');
  const label = button.ownerDocument.createElement('span');
  label.className = 'txt-icon-label';
  label.textContent = name;
  button.replaceChildren(iconSvg(button.ownerDocument, icon), label);
  return true;
}

export function iconifyTree(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.localName === 'button') iconifyButton(root);
  for (const button of root.querySelectorAll('button')) iconifyButton(button);
}

export function installTextButtonIcons(document) {
  iconifyTree(document.body);
  if (typeof MutationObserver !== 'function') return null;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target.nodeType === 1 && record.target.localName === 'button') iconifyButton(record.target);
      for (const node of record.addedNodes) iconifyTree(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}
