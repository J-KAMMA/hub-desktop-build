// コミュニティの流れの並び：新着（既定）・人気・トップ。種類のチップ（kind）とは別の軸で、重ねて使う。
// トップだけ期間（今日・今週・今月・すべて）を持ち、期間の中の反応の重みで並べる。人気は7日のまま。
export const COMMUNITY_ORDERS = Object.freeze([["latest", "新着"], ["popular", "人気"], ["top", "トップ"]]);
export const POPULAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const TOP_PERIODS = Object.freeze([["day", "今日", 24 * 60 * 60 * 1000], ["week", "今週", POPULAR_WINDOW_MS], ["month", "今月", 30 * 24 * 60 * 60 * 1000], ["all", "すべて", Infinity]]);
export const normalizeCommunityOrder = (value) => (value === "popular" || value === "top" ? value : "latest");
export const normalizeTopPeriod = (value) => (TOP_PERIODS.some(([key]) => key === value) ? value : "week");

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
const time = (message) => { const at = Date.parse(message?.createdAt); return Number.isFinite(at) ? at : 0; };

// 反応の重み：返信×2 + いいね（リアクションの合計）+ リポスト。
export function communityPopularity(message) {
  const replies = count(message?.engagement?.replyCount ?? message?.replyCount ?? message?.counts?.replies);
  const reposts = count(message?.engagement?.repostCount ?? message?.repostCount ?? message?.counts?.reposts);
  const likes = Array.isArray(message?.reactions) ? message.reactions.reduce((sum, item) => sum + count(item?.count), 0) : count(message?.likeCount ?? message?.counts?.likes);
  return replies * 2 + likes + reposts;
}

// 種類で絞り（kind が null ならそのまま）、並びを掛ける。固定した投稿は常に先頭。
export function orderCommunityMessages(messages, { order = "latest", kind = null, now = Date.now(), period = "week" } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((message) => !kind || (message.communityKind ?? message.kind ?? message.type) === kind);
  const byTime = (a, b) => time(b) - time(a) || String(b.id).localeCompare(String(a.id));
  const sort = normalizeCommunityOrder(order);
  const popular = sort !== "latest";
  const span = sort === "top" ? TOP_PERIODS.find(([key]) => key === normalizeTopPeriod(period))[2] : POPULAR_WINDOW_MS;
  const score = new Map();
  if (popular) for (const message of list) score.set(message, now - time(message) <= span ? communityPopularity(message) : 0);
  const sorted = [...list].sort(popular ? (a, b) => score.get(b) - score.get(a) || byTime(a, b) : byTime);
  return [...sorted.filter((message) => message.pinnedAt), ...sorted.filter((message) => !message.pinnedAt)];
}
