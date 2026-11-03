// リストの画面の部品（2026-11-02）。区切り線の行・空の状態・静かなエラー。枠つきのカードは使わない。
// app.js の loadCatalog("lists") が使う。DOM だけを触り、通信はしない。
const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export const validLists = (data) => (Array.isArray(data?.lists) ? data.lists : [])
  .filter((list) => list && typeof list.id === "string" && list.id && typeof list.name === "string");

/** 読み込み中も区切り線の行（枠は付けない）。 */
export function listRowsSkeleton(document, count = 3) {
  const rows = el(document, "div", "list-rows");
  rows.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) {
    const row = el(document, "div", "list-row list-row-skeleton");
    for (const width of ["skeleton-line w40", "skeleton-line w60"]) row.append(el(document, "div", `skeleton-block ${width}`));
    rows.append(row);
  }
  return rows;
}

/** 読めなかったときの静かな1行と再試行。読み込み中の表示を残さない。 */
export function listRowsError(document, retry, message = "読み込めませんでした") {
  const line = el(document, "p", "list-rows-error");
  line.setAttribute("role", "alert");
  const button = el(document, "button", "btn-ghost", "再試行");
  button.type = "button";
  button.onclick = () => { button.disabled = true; retry(); };
  line.append(el(document, "span", "", message), button);
  return line;
}

/** 名前・人数（薄い字）・あれば1行の説明。押すとそのリストを開く。0件は「リストを作る」つきの空の状態。 */
export function renderListsRows(document, target, data, { onOpen, onCreate, emptyState }) {
  const lists = validLists(data);
  if (!lists.length) {
    const empty = emptyState("リストはまだありません");
    empty.classList.add("lists-empty");
    const create = el(document, "button", "approve", "リストを作る");
    create.type = "button";
    create.onclick = onCreate;
    empty.append(create);
    target.replaceChildren(empty);
    return;
  }
  const rows = el(document, "div", "list-rows");
  rows.setAttribute("role", "list");
  for (const list of lists) {
    const row = el(document, "button", "list-row");
    row.type = "button";
    row.setAttribute("role", "listitem");
    const head = el(document, "span", "list-row-head");
    head.append(el(document, "strong", "list-row-name", list.name || "リスト"),
      el(document, "span", "list-row-count", `${(Array.isArray(list.profileIds) ? list.profileIds : []).length}人`));
    row.append(head);
    const description = typeof list.description === "string" ? list.description.trim() : "";
    if (description) row.append(el(document, "span", "list-row-description", description));
    row.onclick = () => onOpen(list);
    rows.append(row);
  }
  target.replaceChildren(rows);
}
