// 会話の連結線（X・Threads・Bluesky と同じ）。見た目だけ。返信関係は「返信先 @handle」の文が伝える。
// 上の行が親、すぐ下の行がその直接の返信のときだけ線をつなぐ。間が空けば切れる。
const authorKey = (post) => String(post?.authorProfileId ?? post?.authorHandle ?? post?.handle ?? "");

export function isDirectReply(parent, child) {
  return Boolean(parent?.id && child?.replyToPostId && child.replyToPostId === parent.id);
}

// entries: [{post, node}] か null（null は仕切り＝線が切れる）。selfOnly は同じ書き手の連投だけつなぐ（フィードの札用）。
export function threadLinkFlags(entries, { selfOnly = false } = {}) {
  const flags = entries.map(() => ({ prev: false, next: false }));
  for (let i = 0; i + 1 < entries.length; i += 1) {
    const upper = entries[i]?.post;
    const lower = entries[i + 1]?.post;
    if (!upper || !lower || !isDirectReply(upper, lower)) continue;
    if (selfOnly && (!authorKey(upper) || authorKey(upper) !== authorKey(lower))) continue;
    flags[i].next = true;
    flags[i + 1].prev = true;
  }
  return flags;
}

export function applyThreadLinks(entries, options) {
  const flags = threadLinkFlags(entries, options);
  entries.forEach((entry, index) => {
    if (!entry?.node) return;
    entry.node.classList.toggle("has-thread-next", flags[index].next);
    entry.node.classList.toggle("has-thread-prev", flags[index].prev);
  });
  return flags;
}
