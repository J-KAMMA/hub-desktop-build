// スレッドの2行目（一覧・右列・詳細の見出しで同じ）：種類・返信数・解決済み・最後の動きの相対時刻。
// 文ではなく印と数で見せる。種類は静かな字、解決済みだけ色の印を付ける。
export const THREAD_TYPE_LABELS = Object.freeze({ chat: "雑談", question: "質問", recruitment: "募集", knowledge: "知識" });

const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function threadMetaFacts(thread, relTime) {
  const replies = Math.max(0, (Number(thread?.postCount) || 0) - 1);
  return {
    type: THREAD_TYPE_LABELS[thread?.threadType] ?? "",
    replies,
    solved: Boolean(thread?.solvedAt || thread?.solved === true),
    pinned: thread?.pinned === true,
    closed: thread?.status === "closed",
    when: relTime?.(thread?.updatedAt) ?? "",
  };
}

export function threadRowMeta(document, thread, { relTime, icon, className = "thread-row-meta" }) {
  const facts = threadMetaFacts(thread, relTime);
  const meta = make(document, "div", className);
  if (facts.type) meta.append(make(document, "span", "thread-row-type", facts.type));
  const count = make(document, "span", "thread-row-count");
  count.setAttribute("aria-label", `返信 ${facts.replies}件`);
  count.title = "返信";
  if (icon) count.innerHTML = icon("reply");
  count.append(make(document, "span", "", String(facts.replies)));
  meta.append(count);
  if (facts.solved) {
    const solved = make(document, "span", "thread-row-solved");
    if (icon) solved.innerHTML = icon("check");
    solved.append(make(document, "span", "", "解決済み"));
    meta.append(solved);
  }
  if (facts.pinned) meta.append(make(document, "span", "thread-row-flag", "ピン留め"));
  if (facts.closed) meta.append(make(document, "span", "thread-row-flag", "受付終了"));
  if (facts.when) {
    const when = make(document, "time", "thread-row-when", facts.when);
    if (Number.isFinite(Date.parse(thread?.updatedAt))) { when.dateTime = new Date(thread.updatedAt).toISOString(); when.title = new Date(thread.updatedAt).toLocaleString("ja-JP"); }
    meta.append(when);
  }
  return meta;
}
