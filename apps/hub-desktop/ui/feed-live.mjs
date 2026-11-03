// フィードの新着確認（Xと同じ作法）。
// 見えている間だけ60秒ごとに既存の hub_feed を読み、表示中の最新より新しい投稿があれば
// 数だけをピルで知らせる。勝手には差し込まず、スクロールも動かさない。失敗は黙って次の周で取り直す。
export const FEED_LIVE_INTERVAL_MS = 60_000;
const POLLED_SCOPES = new Set(["recommended", "following", "popular"]);

export function createFeedLive({
  document, invoke, intervalMs = FEED_LIVE_INTERVAL_MS,
  active,        // () => フィードの通常表示（旧形式）が前面にある
  scope,         // () => "recommended" | "following" | "popular" | "list"
  token,         // () => 読み込みの世代。変わったら結果を捨てる
  shown,         // () => ({ ids: Set<string>, newest: number })  表示中の投稿ID と最新の作成時刻
  getItems, setItems,
  pill, pillButton,
  render,        // (posts) => 先頭へ足す
  scrollTop,     // () => 列の先頭へ
  reload,        // () => 最新を読み直す
  limit = 20,
}) {
  let timer = null, inflight = false, disposed = false;
  const visible = () => document.visibilityState !== "hidden";
  const eligible = () => !disposed && visible() && active() === true;

  const showPill = (posts) => {
    setItems(posts);
    pillButton.textContent = `新しいポスト（${posts.length}）`;
    pill.hidden = posts.length === 0;
  };

  async function check() {
    if (inflight || !eligible() || !POLLED_SCOPES.has(scope())) return;
    const base = shown();
    if (!base || !(base.newest > 0)) return;
    const stamp = token(), wanted = scope();
    inflight = true;
    try {
      const result = await invoke("hub_feed", { scope: wanted, limit });
      if (stamp !== token() || !eligible() || wanted !== scope()) return;
      const posts = Array.isArray(result?.posts) ? result.posts : [];
      const fresh = posts
        .filter((post) => post?.id && !base.ids.has(post.id) && (Date.parse(post.createdAt) || 0) > base.newest)
        .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      showPill(fresh);
    } catch { /* 黙って、いまの表示を残して次の周で取り直す */ }
    finally { inflight = false; }
  }

  function sync() {
    if (eligible()) {
      if (timer === null) { timer = setInterval(() => void check(), intervalMs); void check(); }
    } else if (timer !== null) { clearInterval(timer); timer = null; }
  }

  function showNew() {
    const posts = getItems();
    if (posts.length) render(posts);
    setItems([]);
    pill.hidden = true;
    scrollTop();
  }

  function refreshNow() {
    setItems([]);
    pill.hidden = true;
    scrollTop();
    return reload();
  }

  pillButton.onclick = showNew;
  const onVisible = () => sync();
  document.addEventListener("visibilitychange", onVisible);
  const dispose = () => { disposed = true; sync(); document.removeEventListener("visibilitychange", onVisible); };
  return { sync, check, showNew, refreshNow, dispose, running: () => timer !== null };
}
