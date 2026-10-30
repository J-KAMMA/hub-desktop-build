// Hub Desktop ゲーム画面（ストア一覧 + このPCのゲーム）。
// 機種バッジと発売日の表記は apps/hub/lib/game-store-ui.ts と同じ規則（TS は窓から読めないので写し）。
const PLATFORM_BADGES = {
  PC: "PC", Windows: "Windows", macOS: "macOS", Linux: "Linux",
  "PlayStation 5": "PS5", "PlayStation 4": "PS4",
  "Xbox Series X|S": "Xbox Series", "Xbox One": "Xbox One",
  "Nintendo Switch": "Switch", iOS: "iOS", Android: "Android",
};

export function gamePlatformBadge(name) {
  if (Object.hasOwn(PLATFORM_BADGES, name)) return PLATFORM_BADGES[name];
  const trimmed = String(name).trim();
  return trimmed.length > 16 ? `${trimmed.slice(0, 15)}…` : trimmed;
}

export function formatGameReleaseDate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return /^\d{4}$/.test(value) ? `${value}年` : null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

/** API 応答を表示用に絞る。slug の無い行は開き先が無いので捨てる。価格は API が返したときだけ出す。 */
export function normalizeStoreGames(data) {
  const rows = Array.isArray(data?.games) ? data.games : [];
  return rows
    .filter((row) => row && typeof row.slug === "string" && row.slug && typeof row.title === "string" && row.title)
    .map((row) => ({
      slug: row.slug,
      title: row.title,
      summary: typeof row.summary === "string" ? row.summary : "",
      imageUrl: typeof row.imageUrl === "string" ? row.imageUrl : "",
      platforms: Array.isArray(row.platforms) ? row.platforms.filter((p) => typeof p === "string") : [],
      releaseDate: typeof row.releaseDate === "string" ? row.releaseDate : null,
      price: typeof row.priceLabel === "string" && row.priceLabel ? row.priceLabel : row.free === true ? "無料" : "",
    }));
}

export function filterStoreGames(games, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return games;
  return games.filter((g) => `${g.title} ${g.summary}`.toLowerCase().includes(needle));
}

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stateBlock(document, title, body, retry) {
  const panel = el(document, "div", "state-panel");
  panel.append(el(document, "p", "state-title", title), el(document, "p", "state-body", body));
  if (retry) {
    const button = el(document, "button", "btn btn-secondary state-action", "もう一度読み込む");
    button.type = "button";
    button.onclick = retry;
    panel.append(button);
  }
  return panel;
}

function badges(document, platforms) {
  const row = el(document, "div", "games-badges");
  for (const name of platforms.slice(0, 4)) row.append(el(document, "span", "games-badge", gamePlatformBadge(name)));
  return row;
}

function capsule(document, game, { asset, open, featured }) {
  const card = el(document, "button", featured ? "games-capsule games-featured" : "games-capsule");
  card.type = "button";
  card.dataset.gameSlug = game.slug;
  const media = el(document, "div", "games-media");
  if (game.imageUrl) {
    const img = el(document, "img");
    img.alt = "";
    img.loading = "lazy";
    asset(img, game.imageUrl);
    media.append(img);
  }
  const body = el(document, "div", "games-body");
  body.append(el(document, "strong", "games-title", game.title));
  if (featured && game.summary) body.append(el(document, "p", "games-summary", game.summary));
  if (game.platforms.length) body.append(badges(document, game.platforms));
  const meta = [formatGameReleaseDate(game.releaseDate), game.price].filter(Boolean);
  if (meta.length) body.append(el(document, "span", "games-meta", meta.join(" ・ ")));
  card.append(media, body);
  card.onclick = () => open(game);
  return card;
}

export function renderStoreGames(document, target, games, deps) {
  if (!games.length) {
    target.replaceChildren(stateBlock(document, "ゲームが見つかりません", "条件を変えるか、Hubに作品が登録されるのをお待ちください。", deps.retry));
    return;
  }
  const [first, ...rest] = games;
  const grid = el(document, "div", "games-grid");
  grid.append(...rest.map((g) => capsule(document, g, deps)));
  target.replaceChildren(capsule(document, first, { ...deps, featured: true }), grid);
}

export function renderStoreLoading(document, target) {
  const wrap = el(document, "div", "games-skeleton");
  wrap.setAttribute("aria-busy", "true");
  for (let i = 0; i < 4; i += 1) wrap.append(el(document, "div", "games-skeleton-card"));
  target.replaceChildren(wrap);
}

export function renderStoreError(document, target, message, retry) {
  target.replaceChildren(stateBlock(document, "ゲームを読み込めませんでした", message, retry));
}

/** このPCのゲーム（invoke("games") の行）。起動と登録解除だけ。 */
export function renderLocalGames(document, target, entries, { launch, remove }) {
  if (!entries.length) {
    target.replaceChildren(el(document, "p", "games-local-empty", "このPCに登録したゲームはありません。「ゲームを追加」から実行ファイルを選ぶと、ここから起動できます。"));
    return;
  }
  target.replaceChildren(...entries.map((entry) => {
    const row = el(document, "div", "games-local-row");
    row.dataset.gameId = String(entry.id);
    const text = el(document, "div", "games-local-text");
    text.append(el(document, "strong", "games-title", entry.title), el(document, "span", "games-meta", entry.executablePath ?? ""));
    const play = el(document, "button", "btn btn-primary", "このPCで起動");
    play.type = "button";
    play.onclick = () => launch(entry, play);
    const del = el(document, "button", "btn btn-ghost", "削除");
    del.type = "button";
    del.onclick = () => remove(entry, del);
    row.append(text, play, del);
    return row;
  }));
}
