// コミュニティ画面の内側の列に出す、参加中の一覧（左の記号の帯には置かない）。
// 最大5件と「すべて見る」。署名前・未参加なら何も描かない。5分は同じ結果を使い、描画のたびには読まない。
// データは既存の hub_resource の communities（communities と自分の memberships）だけ。新しい通信は足さない。

export const NAV_COMMUNITY_LIMIT = 5;
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

export function renderNavCommunities(document, host, model, { onOpen, onAll, current = "", asset } = {}) {
  host.replaceChildren();
  if (!model.rows.length) { host.hidden = true; return; }
  for (const row of model.rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-community sidebar-context-item";
    button.dataset.communityId = row.id;
    if (row.id === current) button.setAttribute("aria-current", "true");
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
  }
  const all = document.createElement("button");
  all.type = "button";
  all.className = "nav-community nav-community-all sidebar-context-item";
  all.textContent = "すべて見る";
  all.addEventListener("click", () => onAll?.());
  host.append(all);
  host.hidden = false;
}

export function createNavCommunities({ document, host, load, signedIn, onOpen, onAll, asset, now = () => Date.now() }) {
  let model = null;
  let at = 0;
  let loading = false;
  let current = "";
  let epoch = 0;
  const paint = () => renderNavCommunities(document, host, model ?? { rows: [] }, { onOpen, onAll, current, asset });
  return {
    async refresh({ force = false } = {}) {
      if (!signedIn()) { model = null; at = 0; paint(); return; }
      if (loading) return;
      if (!force && model && now() - at < NAV_COMMUNITY_TTL_MS) { paint(); return; }
      loading = true;
      const mine = ++epoch;
      try {
        const data = await load();
        if (mine !== epoch) return;
        model = joinedCommunities(data);
        at = now();
      } catch {
        if (mine !== epoch) return;
        model = null;
      } finally {
        loading = false;
      }
      paint();
    },
    setCurrent(id) { current = typeof id === "string" ? id : ""; if (model) paint(); },
    clear() { epoch++; model = null; at = 0; current = ""; paint(); },
  };
}
