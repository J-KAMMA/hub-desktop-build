// 返信の木（2026-11-10）。返信を親子で入れ子にし、左の縦の線を押すとその枝を畳む（Reddit と同じ置き場）。
// 深さは REPLY_DEPTH_CAP まで。それより深い枝は「続き」の1行にして、その返信の詳細で開く（幅を食いつぶさない）。
// ここは並べるだけ：行は renderItem が作り、読み足しは loadChildren、続きは onContinue。
export const REPLY_DEPTH_CAP = 4;

const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

/**
 * 平らな一覧を木にする。根（rootId）への返信が1段目。親が一覧に無い返信は1段目に置く（捨てない）。並びは渡された順のまま。
 * 返り値の節：{ item, children, total }（total は子孫の数）。循環は切る。
 */
export function buildReplyTree(items, rootId, { idOf = (item) => item.id, parentOf = (item) => item.replyToPostId } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item && idOf(item) != null && idOf(item) !== rootId);
  const nodes = new Map();
  for (const item of list) if (!nodes.has(idOf(item))) nodes.set(idOf(item), { item, children: [], total: 0 });
  const top = [];
  const climbs = (id, target) => { const seen = new Set(); let at = id; while (at != null && nodes.has(at) && !seen.has(at)) { if (at === target) return true; seen.add(at); at = parentOf(nodes.get(at).item); } return false; };
  for (const node of nodes.values()) {
    const parent = parentOf(node.item);
    const id = idOf(node.item);
    if (parent != null && parent !== rootId && parent !== id && nodes.has(parent) && !climbs(parent, id)) nodes.get(parent).children.push(node);
    else top.push(node);
  }
  const sum = (node) => { node.total = node.children.reduce((n, child) => n + 1 + sum(child), 0); return node.total; };
  top.forEach(sum);
  return top;
}

const CHEVRON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/**
 * 木を描く。options:
 *  renderItem(item, depth) -> Node, idOf, maxDepth, collapsed: Set（畳んだ id。呼び出し側が持てば描き直しても残る）,
 *  onContinue(item) 深さの上限より下を開く, pendingCount(item) -> 未読み込みの返信の数, loadChildren(item) -> Promise<items[]>, parentOf
 */
export function renderReplyTree(document, nodes, options = {}, depth = 1) {
  const { renderItem, idOf = (item) => item.id, maxDepth = REPLY_DEPTH_CAP, collapsed = new Set(), onContinue, pendingCount = () => 0, loadChildren, parentOf } = options;
  const list = make(document, 'div', depth === 1 ? 'reply-tree' : 'reply-children');
  if (depth === 1) list.setAttribute('role', 'tree');
  for (const node of nodes) {
    const id = idOf(node.item);
    const wrap = make(document, 'div', 'reply-node');
    wrap.dataset.replyId = id; wrap.dataset.depth = String(depth);
    wrap.setAttribute('role', 'treeitem');
    const self = make(document, 'div', 'reply-item');
    self.append(renderItem(node.item, depth));
    wrap.append(self);

    const unfold = make(document, 'button', 'reply-unfold');
    unfold.type = 'button'; unfold.setAttribute('data-keep-text', '');
    const label = (n) => { unfold.innerHTML = CHEVRON; unfold.append(make(document, 'span', '', `返信 ${n}`)); unfold.setAttribute('aria-label', `返信 ${n}件を開く`); };
    const mountBranch = (children, total) => {
      const branch = make(document, 'div', 'reply-branch');
      const guide = make(document, 'button', 'reply-guide');
      guide.type = 'button'; guide.title = '畳む';
      guide.setAttribute('aria-label', `返信 ${total}件を畳む`);
      const set = (open) => {
        branch.hidden = !open; unfold.hidden = open;
        wrap.setAttribute('aria-expanded', String(open));
        if (open) { collapsed.delete(id); delete wrap.dataset.collapsed; } else { collapsed.add(id); wrap.dataset.collapsed = 'true'; label(total); }
      };
      guide.onclick = (event) => { event.stopPropagation(); set(false); unfold.focus?.(); };
      unfold.onclick = (event) => { event.stopPropagation(); set(true); guide.focus?.(); };
      branch.append(guide, renderReplyTree(document, children, options, depth + 1));
      wrap.append(branch, unfold);
      set(!collapsed.has(id));
    };

    const pending = node.children.length ? 0 : Math.max(0, Number(pendingCount(node.item)) || 0);
    if (node.children.length && depth < maxDepth) mountBranch(node.children, node.total);
    else if ((node.children.length || pending) && depth >= maxDepth) {
      // 深さの上限：ここから下は入れ子にしない。
      const more = make(document, 'button', 'reply-continue');
      more.type = 'button'; more.setAttribute('data-keep-text', '');
      const n = node.children.length ? node.total : pending;
      more.append(make(document, 'span', '', `続き ${n}`));
      more.insertAdjacentHTML('beforeend', '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>');
      more.setAttribute('aria-label', `続きの返信 ${n}件を開く`);
      more.onclick = (event) => { event.stopPropagation(); onContinue?.(node.item); };
      wrap.append(more);
    } else if (pending && loadChildren) {
      // 一覧に子が入っていない返信：押したときに読む。
      label(pending);
      let busy = false;
      unfold.onclick = (event) => {
        event.stopPropagation();
        if (busy) return;
        busy = true; unfold.disabled = true;
        Promise.resolve(loadChildren(node.item)).then((items) => {
          const children = buildReplyTree(items, id, { idOf, ...(parentOf ? { parentOf } : {}) });
          if (!children.length) { unfold.hidden = true; return; }
          unfold.disabled = false; unfold.remove();
          node.children = children; node.total = children.reduce((n, child) => n + 1 + child.total, 0);
          collapsed.delete(id);
          mountBranch(children, node.total);
        }, () => { busy = false; unfold.disabled = false; });
      };
      wrap.append(unfold);
    }
    list.append(wrap);
  }
  return list;
}
