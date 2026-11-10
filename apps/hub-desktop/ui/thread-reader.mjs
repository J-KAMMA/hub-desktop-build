// ../../hub/lib/thread-search.ts
function normalizeSearchText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP");
}
function searchThreadPosts(posts, query) {
  const terms = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return posts;
  return posts.filter((post) => {
    const searchable = normalizeSearchText([
      String(post.no),
      `#${post.no}`,
      post.displayName,
      post.authorHandle ?? "",
      post.body
    ].join(" "));
    return terms.every((term) => searchable.includes(term));
  });
}
function filterThreadPosts(posts, query, filters = {}) {
  const author = normalizeSearchText(filters.author ?? "").trim();
  const from = filters.from ? Date.parse(filters.from) : Number.NaN;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999`) : Number.NaN;
  return searchThreadPosts(posts, query).filter((post) => {
    const identity = normalizeSearchText(`${post.displayName} ${post.authorHandle ?? ""}`);
    const timestamp = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
    if (author && !identity.includes(author)) return false;
    if (filters.minScore != null && (post.voteSummary?.score ?? 0) < filters.minScore) return false;
    if (filters.role && filters.role !== "all" && post.knowledge?.role !== filters.role) return false;
    if (filters.hasSource && !post.knowledge?.sources?.length) return false;
    if (!Number.isNaN(from) && (Number.isNaN(timestamp) || timestamp < from)) return false;
    if (!Number.isNaN(to) && (Number.isNaN(timestamp) || timestamp > to)) return false;
    return true;
  });
}

// ../../hub/lib/thread-tree.ts
function compare(sort) {
  return (left, right) => {
    const l = left.voteSummary ?? { up: 0, down: 0, score: 0 };
    const r = right.voteSummary ?? { up: 0, down: 0, score: 0 };
    if (sort === "new") return right.createdAt.localeCompare(left.createdAt) || right.no - left.no;
    if (sort === "old") return left.createdAt.localeCompare(right.createdAt) || left.no - right.no;
    if (sort === "top") return r.score - l.score || r.up - l.up || left.no - right.no;
    if (sort === "controversial") {
      const leftBalance = Math.min(l.up, l.down);
      const rightBalance = Math.min(r.up, r.down);
      return rightBalance - leftBalance || r.up + r.down - (l.up + l.down) || left.no - right.no;
    }
    const leftConfidence = l.score * Math.log2(l.up + l.down + 2) + Math.min(l.up, 12) - Math.min(l.down, 8);
    const rightConfidence = r.score * Math.log2(r.up + r.down + 2) + Math.min(r.up, 12) - Math.min(r.down, 8);
    return rightConfidence - leftConfidence || r.score - l.score || left.no - right.no;
  };
}
function buildThreadTreeRows(posts, sort) {
  if (!posts.length) return [];
  const root = [...posts].sort((a, b) => a.no - b.no)[0];
  const known = new Set(posts.map((post) => post.id));
  const children = /* @__PURE__ */ new Map();
  for (const post of posts) {
    if (post.id === root.id) continue;
    const parentId = post.replyToPostId && known.has(post.replyToPostId) ? post.replyToPostId : root.id;
    const siblings = children.get(parentId) ?? [];
    siblings.push(post);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compare(sort));
  const rows = [{ post: root, depth: 0, childCount: children.get(root.id)?.length ?? 0 }];
  const visited = /* @__PURE__ */ new Set([root.id]);
  const visit = (parentId, depth) => {
    for (const post of children.get(parentId) ?? []) {
      if (visited.has(post.id)) continue;
      visited.add(post.id);
      rows.push({ post, depth, childCount: children.get(post.id)?.length ?? 0 });
      visit(post.id, depth + 1);
    }
  };
  visit(root.id, 1);
  return rows;
}

// ../../hub/lib/spotlight-posts.ts
function explainSpotlightScore(post, bestAnswerPostId) {
  const vote = post.spotlightScore ?? post.voteSummary?.score ?? 0;
  const sources = post.knowledge?.sources ?? [];
  const sourceBonus = Math.min(3, sources.reduce((total, source) => total + (source.kind === "primary" ? 2 : source.kind === "news" ? 1 : 0), 0));
  const correctionBonus = post.knowledge?.role === "correction" ? 2 : 0;
  const freshnessPenalty = post.knowledge?.freshness === "outdated" ? -4 : post.knowledge?.freshness === "possibly_outdated" ? -1 : 0;
  const bestAnswerBonus = post.id === bestAnswerPostId ? 5 : 0;
  return { total: vote + sourceBonus + correctionBonus + freshnessPenalty + bestAnswerBonus, vote, sourceBonus, correctionBonus, freshnessPenalty, bestAnswerBonus };
}
var SPOTLIGHT_SCORE_THRESHOLD = 3;
var SPOTLIGHT_REPLY_LIMIT = 20;
function isVisible(post) {
  return !post.deletedAt && !post.moderatedAt && !post.viewerMuted && !post.viewerBlocked;
}
function selectSpotlightPosts(posts, bestAnswerPostId) {
  const first = posts.find((post) => post.no === 1);
  const replies = posts.filter((post) => post.no > 1 && isVisible(post)).filter((post) => post.id === bestAnswerPostId || explainSpotlightScore(post, bestAnswerPostId).total >= SPOTLIGHT_SCORE_THRESHOLD || post.knowledge?.role === "counterpoint" && (post.voteSummary?.up ?? 0) + (post.voteSummary?.down ?? 0) >= 3).sort((left, right) => {
    if (left.id === bestAnswerPostId) return -1;
    if (right.id === bestAnswerPostId) return 1;
    return explainSpotlightScore(right, bestAnswerPostId).total - explainSpotlightScore(left, bestAnswerPostId).total || left.no - right.no;
  }).slice(0, SPOTLIGHT_REPLY_LIMIT);
  const selectedIds = new Set(replies.map((post) => post.id));
  return posts.filter((post) => post === first || selectedIds.has(post.id)).slice().sort((left, right) => left.no - right.no);
}

// ../../hub/lib/thread-knowledge.ts
var ROLE_LABELS = { unspecified: "\u901A\u5E38", answer: "\u56DE\u7B54", context: "\u88DC\u8DB3", counterpoint: "\u53CD\u5BFE\u610F\u898B", question: "\u8CEA\u554F", correction: "\u8A02\u6B63", source: "\u51FA\u5178" };

// thread-reader.src.mjs
function createThreadReader(document, { thread, posts, viewer, renderPost, state: reading = {}, selection = null, isCurrent = () => true, onBeforeRender = () => {
}, onRendered = () => {
} }) {
  const root = document.createElement("section");
  root.className = "thread-reader";
  root.setAttribute("aria-label", "\u6295\u7A3F\u306E\u95B2\u89A7");
  const controls = document.createElement("form");
  controls.className = "detail-form";
  const row = document.createElement("div");
  row.className = "detail-form-row";
  const input = (label, type = "text") => {
    const control = document.createElement("input");
    control.type = type;
    control.setAttribute("aria-label", label);
    control.placeholder = label;
    return control;
  };
  const select = (label, options) => {
    const control = document.createElement("select");
    control.setAttribute("aria-label", label);
    for (const [value, text] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      control.append(option);
    }
    return control;
  };
  const query = input("\u30B9\u30EC\u30C3\u30C9\u5185\u3092\u691C\u7D22", "search");
  query.maxLength = 100;
  const mode = select("\u6295\u7A3F\u306E\u8868\u793A", [["flat", "\u6295\u7A3F\u9806"], ["tree", "\u4F1A\u8A71\u5225"], ["guide", "\u8AAD\u307F\u65B9\u30AC\u30A4\u30C9"]]);
  const sort = select("\u4F1A\u8A71\u306E\u4E26\u3073", [["best", "\u304A\u3059\u3059\u3081"], ["top", "\u9AD8\u8A55\u4FA1"], ["new", "\u65B0\u7740"], ["old", "\u53E4\u3044\u9806"], ["controversial", "\u8CDB\u5426\u3042\u308A"]]);
  row.append(query, mode, sort);
  const advanced = document.createElement("details"), summary = document.createElement("summary");
  summary.textContent = "\u8A73\u3057\u304F\u7D5E\u308A\u8FBC\u3080";
  const filters = document.createElement("div");
  filters.className = "detail-form-row";
  const author = input("\u6295\u7A3F\u8005");
  author.maxLength = 80;
  const score = input("\u6700\u4F4E\u8A55\u4FA1", "number");
  score.step = "1";
  const role = select("\u6295\u7A3F\u306E\u5F79\u5272", [["all", "\u3059\u3079\u3066\u306E\u5F79\u5272"], ...Object.entries(ROLE_LABELS)]);
  const from = input("\u6295\u7A3F\u65E5\u304B\u3089", "date"), to = input("\u6295\u7A3F\u65E5\u307E\u3067", "date");
  const source = input("\u51FA\u5178\u304C\u3042\u308B\u6295\u7A3F\u306E\u307F", "checkbox"), sourceLabel = document.createElement("label");
  sourceLabel.className = "check";
  sourceLabel.append(source, "\u51FA\u5178\u3042\u308A");
  filters.append(author, score, role, from, to, sourceLabel);
  advanced.append(summary, filters);
  controls.append(row, advanced);
  const state = document.createElement("p");
  state.className = "meta";
  state.setAttribute("role", "status");
  const list = document.createElement("div");
  const pager = document.createElement("div");
  pager.className = "detail-form-row";
  const button = (text, action) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "head-action";
    item.textContent = text;
    item.onclick = action;
    return item;
  };
  query.value = reading.query ?? "";
  mode.value = reading.mode ?? "flat";
  sort.value = reading.sort ?? "best";
  author.value = reading.author ?? "";
  score.value = reading.score ?? "";
  role.value = reading.role ?? "all";
  from.value = reading.from ?? "";
  to.value = reading.to ?? "";
  source.checked = reading.source ?? false;
  let page = reading.page ?? 0;
  const selectionStatus = document.createElement("p");
  selectionStatus.className = "meta";
  selectionStatus.hidden = true;
  const visible = (post) => !post.deletedAt && !post.moderatedAt && !post.viewerMuted && !post.viewerBlocked;
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const actualTarget = (post) => post && typeof post.id === "string" && post.id.length >= 1 && post.id.length <= 128 && !/[^A-Za-z0-9_-]/u.test(post.id) && positive(post.no) && visible(post);
  const selectionValid = selection && typeof selection === "object" && !Array.isArray(selection) && Object.keys(selection).every((key2) => ["replyPostId", "postNo", "page", "showReplies"].includes(key2)) && (selection.replyPostId === void 0 || typeof selection.replyPostId === "string" && selection.replyPostId.length >= 1 && selection.replyPostId.length <= 128 && !/[^A-Za-z0-9_-]/u.test(selection.replyPostId)) && (selection.postNo === void 0 || positive(selection.postNo)) && (selection.page === void 0 || positive(selection.page)) && (selection.showReplies === void 0 || typeof selection.showReplies === "boolean");
  const intended = selectionValid && (selection.replyPostId !== void 0 || selection.postNo !== void 0 || selection.page !== void 0 || selection.showReplies === true);
  const key = intended ? JSON.stringify([thread.id, selection.replyPostId ?? null, selection.postNo ?? null, selection.page ?? null, selection.showReplies ?? false]) : null;
  const firstSelection = key && reading.notificationSelectionKey !== key;
  let targetPost = null, targetId = null, targetNo = null, pendingFocus = false, targetCard = null, observer = null, disposed = false;
  const unavailable = () => {
    selectionStatus.setAttribute("role", "status");
    selectionStatus.hidden = false;
    selectionStatus.textContent = "\u901A\u77E5\u306E\u6295\u7A3F\u3092\u8868\u793A\u3067\u304D\u307E\u305B\u3093\u3002\u524A\u9664\u30FB\u975E\u8868\u793A\u3001\u307E\u305F\u306F\u672A\u53D6\u5F97\u306E\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002";
  };
  const stopFocus = () => {
    pendingFocus = false;
    observer?.disconnect();
    observer = null;
  };
  root.dispose = () => {
    disposed = true;
    stopFocus();
  };
  if (selection && !selectionValid) unavailable();
  if (firstSelection && isCurrent()) {
    reading.notificationSelectionKey = key;
    if (selection.replyPostId !== void 0 || selection.postNo !== void 0) {
      const byId = selection.replyPostId === void 0 ? null : posts.filter((post) => post.id === selection.replyPostId);
      const byNo = selection.postNo === void 0 ? null : posts.filter((post) => post.no === selection.postNo);
      if ((!byId || byId.length === 1) && (!byNo || byNo.length === 1) && (!byId || !byNo || byId[0] === byNo[0])) targetPost = byId?.[0] ?? byNo?.[0] ?? null;
      if (!actualTarget(targetPost)) {
        targetPost = null;
        unavailable();
      }
    }
    const requestedPageAvailable = selection.page === void 0 || selection.page <= Math.max(1, Math.ceil(posts.length / 50));
    if (!targetPost && selection.replyPostId === void 0 && selection.postNo === void 0 && !requestedPageAvailable) unavailable();
    if (targetPost || selection.replyPostId === void 0 && selection.postNo === void 0 && requestedPageAvailable) {
      query.value = author.value = score.value = from.value = to.value = "";
      role.value = "all";
      source.checked = false;
      mode.value = "flat";
      page = targetPost ? Math.floor(posts.indexOf(targetPost) / 50) : selection.page ? selection.page - 1 : 0;
      targetId = targetPost?.id ?? null;
      targetNo = targetPost?.no ?? null;
      pendingFocus = Boolean(targetPost);
    }
  }
  const previous = button("\u524D\u306E50\u4EF6", () => {
    stopFocus();
    selectionStatus.hidden = true;
    selectionStatus.removeAttribute("role");
    page--;
    render();
  }), next = button("\u6B21\u306E50\u4EF6", () => {
    stopFocus();
    selectionStatus.hidden = true;
    selectionStatus.removeAttribute("role");
    page++;
    render();
  });
  pager.append(previous, next);
  root.append(controls, selectionStatus, state, list, pager);
  function render() {
    const searching = Boolean(query.value.trim() || author.value || score.value || role.value !== "all" || from.value || to.value || source.checked);
    const found = filterThreadPosts(posts, query.value, { author: author.value, minScore: score.value && Number.isFinite(score.valueAsNumber) ? score.valueAsNumber : void 0, role: role.value, from: from.value, to: to.value, hasSource: source.checked });
    const guided = mode.value === "guide" && !searching;
    const selected = guided ? selectSpotlightPosts(posts, thread.bestAnswerPostId) : found;
    const rows = mode.value === "tree" && !searching ? buildThreadTreeRows(selected, sort.value) : selected.map((post) => ({ post, depth: 0 }));
    const pages = Math.max(1, Math.ceil(rows.length / 50));
    page = Math.max(0, Math.min(page, pages - 1));
    sort.hidden = mode.value !== "tree" || searching;
    onBeforeRender();
    const nodes = rows.slice(page * 50, (page + 1) * 50).flatMap(({ post, depth }) => {
      const card = renderPost(post);
      card.style.marginInlineStart = `${Math.min(depth, 4) * 12}px`;
      if (pendingFocus && post === targetPost) {
        targetCard = card;
        card.dataset.notificationPostId = post.id;
      }
      const output = [];
      if (viewer?.lastReadPostNo > 0 && post.no === viewer.lastReadPostNo + 1) {
        const unread = document.createElement("p");
        unread.className = "meta";
        unread.textContent = "\u3053\u3053\u304B\u3089\u672A\u8AAD";
        output.push(unread);
      }
      output.push(card);
      return output;
    });
    list.replaceChildren(...nodes);
    onRendered(list);
    if (!nodes.length) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "\u6761\u4EF6\u306B\u5408\u3046\u6295\u7A3F\u306F\u3042\u308A\u307E\u305B\u3093";
      list.append(empty);
    }
    state.textContent = `${selected.length}\u4EF6 / ${posts.length}\u4EF6 \xB7 ${page + 1} / ${pages}\u30DA\u30FC\u30B8${guided ? " \xB7 \u8A55\u4FA1\u306F\u6B63\u3057\u3055\u306E\u4FDD\u8A3C\u3067\u306F\u3042\u308A\u307E\u305B\u3093" : ""}`;
    Object.assign(reading, { query: query.value, mode: mode.value, sort: sort.value, author: author.value, score: score.value, role: role.value, from: from.value, to: to.value, source: source.checked, page });
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    pager.hidden = pages === 1;
    state.hidden = !searching && !guided && pages === 1;
  }
  const refresh = () => {
    stopFocus();
    selectionStatus.hidden = true;
    selectionStatus.removeAttribute("role");
    page = 0;
    render();
  };
  controls.onsubmit = (event) => {
    event.preventDefault();
    refresh();
  };
  query.oninput = refresh;
  for (const control of [mode, sort, author, score, role, from, to, source]) control.onchange = refresh;
  render();
  const focusTarget = () => {
    if (!pendingFocus) return;
    if (disposed || !isCurrent()) {
      stopFocus();
      return;
    }
    if (!actualTarget(targetPost) || targetPost.id !== targetId || targetPost.no !== targetNo) {
      stopFocus();
      unavailable();
      return;
    }
    if (!root.isConnected) return;
    if (!targetCard?.isConnected || !root.contains(targetCard)) {
      stopFocus();
      unavailable();
      return;
    }
    stopFocus();
    selectionStatus.setAttribute("role", "status");
    targetCard.tabIndex = -1;
    targetCard.focus({ preventScroll: true });
    targetCard.scrollIntoView?.({ block: "center", inline: "nearest" });
    selectionStatus.hidden = false;
    selectionStatus.textContent = `\u901A\u77E5\u306E\u6295\u7A3F #${targetPost.no} \u3092\u8868\u793A\u3057\u307E\u3057\u305F\u3002`;
  };
  if (pendingFocus && document.defaultView?.MutationObserver) {
    observer = new document.defaultView.MutationObserver(focusTarget);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    focusTarget();
  }
  return root;
}
export {
  createThreadReader
};
