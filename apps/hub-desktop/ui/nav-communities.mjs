// 左の列の「コミュニティ」の下に並べる、具体的なコミュニティの一覧（2026-11-09 所有者）。
// 参加中を先に最大8件、1つも入っていなければ公開の人気から少し（空にしない）。末尾は「すべて」。5分は同じ結果を使い、描画のたびには読まない。
// データは既存の hub_resource の communities（communities と自分の memberships）だけ。新しい通信は足さない。

export const NAV_COMMUNITY_LIMIT = 8;
export const NAV_COMMUNITY_SUGGEST = 5;
export const NAV_COMMUNITY_TTL_MS = 5 * 60 * 1000;

export function joinedCommunities(data, limit = NAV_COMMUNITY_LIMIT) {
  const joined = new Set((Array.isArray(data?.memberships) ? data.memberships : [])
    .filter((item) => item && ["active", "muted"].includes(item.status)).map((item) => item.communityId));
  const all = (Array.isArray(data?.communities) ? data.communities : [])
    .filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && item.name && joined.has(item.id));
  return {
    rows: all.slice(0, limit).map((item) => ({
      id: item.id,
      name: item.name,
      imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : "",
      unread: Number.isSafeInteger(item.unreadCount) && item.unreadCount > 0 ? item.unreadCount : 0,
    })),
    more: all.length > limit,
    total: all.length,
  };
}

/** 参加中が無いとき：公開で、動きの多い順（直近の書き込み数、無ければ人数）。非公開は混ぜない。 */
export function listedCommunities(data, limit = NAV_COMMUNITY_LIMIT) {
  const joined = joinedCommunities(data, limit);
  if (joined.rows.length) return joined;
  const heat = (item) => (Number.isSafeInteger(item.recentMessageCount) ? item.recentMessageCount : Number.isSafeInteger(item.memberCount) ? item.memberCount : 0);
  const open = (Array.isArray(data?.communities) ? data.communities : [])
    .filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && item.name && item.visibility === "public")
    .sort((a, b) => heat(b) - heat(a));
  return {
    rows: open.slice(0, NAV_COMMUNITY_SUGGEST).map((item) => ({ id: item.id, name: item.name, imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : "", unread: 0 })),
    more: open.length > NAV_COMMUNITY_SUGGEST, total: open.length, suggested: true,
  };
}

export function renderNavCommunities(document, host, model, { onOpen, onAll, current = "", asset, subs = [], onSub, extra = null } = {}) {
  host.replaceChildren();
  // 参加中に無いコミュニティを開いているときは、その行を先頭に足す（中身はその下）。
  const rows = current && extra && extra.id === current && !model.rows.some((row) => row.id === current) ? [extra, ...model.rows] : model.rows;
  if (!rows.length) { host.hidden = true; return; }
  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-community sidebar-context-item";
    button.dataset.communityId = row.id;
    // 現在の印は列に1つだけ：下の行（共有・メンバー）を見ている間はその行が持ち、コミュニティの行は「開いている」だけになる。
    if (row.id === current) { if (subs.some((sub) => sub.selected)) button.dataset.open = "true"; else button.setAttribute("aria-current", "true"); }
    const face = document.createElement("span");
    face.className = "nav-community-face";
    if (row.imageUrl && asset) {
      const img = document.createElement("img");
      img.alt = "";
      asset(img, row.imageUrl);
      face.append(img);
    } else {
      face.textContent = [...row.name][0] ?? "";
    }
    const name = document.createElement("span");
    name.className = "nav-community-name";
    name.textContent = row.name;
    button.append(face, name);
    if (row.unread) {
      const badge = document.createElement("b");
      badge.className = "nav-badge";
      badge.textContent = row.unread > 99 ? "99+" : String(row.unread);
      button.append(badge);
    }
    button.addEventListener("click", () => onOpen?.(row));
    host.append(button);
    // 開いているコミュニティの下に 共有 / メンバー（字のまま：「共有」を記号に置き換えない）。流れはコミュニティの行そのもの。
    if (row.id === current) {
      for (const sub of subs) {
        // 部品（チャンネルの列など）はそのまま差し込む。
        if (sub.node) { host.append(sub.node); continue; }
        const item = document.createElement("button");
        item.type = "button";
        item.className = "nav-community-sub sidebar-context-item";
        item.dataset.section = sub.key;
        item.setAttribute("data-keep-text", "");
        item.textContent = sub.label;
        if (sub.selected) item.setAttribute("aria-current", "page");
        item.addEventListener("click", () => onSub?.(sub.key, row));
        host.append(item);
      }
    }
  }
  const all = document.createElement("button");
  all.type = "button";
  all.className = "nav-community nav-community-all sidebar-context-item";
  all.textContent = "すべて";
  all.addEventListener("click", () => onAll?.());
  host.append(all);
  host.hidden = false;
}

export function createNavCommunities({ document, host, load, signedIn, onOpen, onAll, onSub, asset, now = () => Date.now() }) {
  let model = null;
  let at = 0;
  let loading = false;
  let current = "";
  let subs = [];
  let extra = null;
  let epoch = 0;
  const paint = () => renderNavCommunities(document, host, model ?? { rows: [] }, { onOpen, onAll, current, asset, subs, onSub, extra });
  return {
    async refresh({ force = false } = {}) {
      if (loading) return;
      if (!force && model && now() - at < NAV_COMMUNITY_TTL_MS) { paint(); return; }
      loading = true;
      const mine = ++epoch;
      try {
        const data = await load();
        if (mine !== epoch) return;
        model = listedCommunities(signedIn() ? data : { communities: data?.communities });
        at = now();
      } catch {
        if (mine !== epoch) return;
        model = null;
      } finally {
        loading = false;
      }
      paint();
    },
    setCurrent(id, items = [], row = null) { current = typeof id === "string" ? id : ""; subs = current && Array.isArray(items) ? items : []; extra = current && row?.name ? { id: current, name: String(row.name), imageUrl: row.imageUrl ?? "", unread: 0 } : extra?.id === current ? extra : null; if (model) paint(); },
    clear() { epoch++; model = null; at = 0; current = ""; subs = []; extra = null; paint(); },
  };
}
