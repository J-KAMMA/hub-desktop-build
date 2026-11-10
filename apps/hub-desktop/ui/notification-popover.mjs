// 左のアイコン列の「通知」から開く小さな一覧（2026-11-07 操作の手間の測定）。
// 最新の数件を出し、押すとその通知を開く。最後の行「すべて見る」で通知の画面へ。Esc か外側の押下で閉じる。
// 読み出しと開き方は呼び出し側（既存の通知の口）が持つ。この部品は描画と開閉だけを受け持つ。
export const POPOVER_LIMIT = 5;

export function createNotificationPopover({document, anchor, onOpenItem, onAll, onToggle = () => {}, limit = POPOVER_LIMIT}) {
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const root = el('div', 'notif-pop');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '最新の通知');
  let opened = false;

  const place = () => {
    const rect = anchor.getBoundingClientRect();
    root.style.left = `${Math.round(rect.right + 8)}px`;
    root.style.top = `${Math.max(8, Math.round(rect.top))}px`;
  };
  const outside = (event) => { if (opened && !root.contains(event.target) && !anchor.contains(event.target)) close(); };
  const onKey = (event) => { if (event.key === 'Escape' && opened) { event.stopPropagation(); close(); anchor.focus?.(); } };

  function open() {
    if (opened) return;
    opened = true;
    if (!root.isConnected) document.body.append(root);
    place();
    root.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    onToggle(true);
  }
  function close() {
    if (!opened) return;
    opened = false;
    root.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    onToggle(false);
  }
  const toggle = () => (opened ? close() : open());

  // model: {state: 'loading' | 'error' | 'signedout' | 'ready', items: [{title, text, unread, time, ref}], message}
  function render(model) {
    const rows = [];
    if (model.state === 'ready') {
      if (!model.items.length) rows.push(el('p', 'notif-pop-note', '通知はありません'));
      for (const item of model.items.slice(0, limit)) {
        const row = el('button', 'notif-pop-row' + (item.unread ? ' unread' : ''));
        row.type = 'button';
        row.append(el('span', 'notif-pop-title', item.title), el('span', 'notif-pop-text', item.text));
        if (item.time) row.append(el('span', 'notif-pop-time', item.time));
        row.setAttribute('aria-label', `${item.unread ? '未読 ' : ''}${item.title} ${item.text}`);
        // 開く処理（既読にする書き込みを含む）が終わるまで、論理的には開いたままにする。見た目だけ先に畳む。
        row.onclick = () => { root.hidden = true; Promise.resolve().then(() => onOpenItem(item.ref)).catch(() => {}).finally(close); };
        rows.push(row);
      }
    } else {
      rows.push(el('p', 'notif-pop-note', model.message || (model.state === 'loading' ? '読み込んでいます…' : '通知を表示できません')));
    }
    const all = el('button', 'notif-pop-all', 'すべて見る');
    all.type = 'button';
    all.onclick = () => { close(); onAll(); };
    rows.push(all);
    root.replaceChildren(...rows);
  }

  return {root, open, close, toggle, render, isOpen: () => opened};
}
