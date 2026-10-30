// 右列の各表示の中だけで効く「戻る・進む」（2026-10-18 所有者: 上の行の右列の真上に、その表示の戻る・進むを出す）。
// 一覧 ⇄ 詳細（会話・投稿・コミュニティ・曲・検索結果）や AI の作業の切り替えを、表示ごとに別々に覚える。
// ブラウザは自分の履歴（rb-back / rb-forward）を持つのでここでは扱わない。
// handler(entry, step) は true（移った）、false（もう開けない：その項目を捨てる）、null（いまは動けない）を返す。
export function createRailNav({ onChange = () => {} } = {}) {
  const views = new Map();
  const handlers = new Map();
  let navigating = false;
  const stateOf = (view) => {
    let state = views.get(view);
    if (!state) { state = { entries: [], index: -1 }; views.set(view, state); }
    return state;
  };
  function handle(view, handler) { handlers.set(view, handler); }
  // 利用者の操作で別の項目へ移った。先頭が空なら、移る前の状態（既定は一覧）を最初の項目にする。
  function visit(view, key, data, base = { key: "list" }) {
    if (navigating) return;
    const state = stateOf(view);
    if (!state.entries.length) { state.entries.push(base); state.index = 0; }
    if (state.entries[state.index]?.key === key) { state.entries[state.index] = { key, data }; return; }
    state.entries.splice(state.index + 1);
    state.entries.push({ key, data });
    state.index = state.entries.length - 1;
    onChange(view);
  }
  // 利用者が詳細を閉じた＝一覧へ戻った。直前が一覧ならそこへ戻り、閉じた詳細は「進む」で開き直せる。
  function closed(view) {
    if (navigating) return;
    const state = views.get(view);
    if (!state || state.index < 0 || state.entries[state.index].key === "list") return;
    if (state.index > 0 && state.entries[state.index - 1].key === "list") { state.index--; onChange(view); return; }
    visit(view, "list");
  }
  function can(view, step) {
    const state = views.get(view);
    if (!state || navigating) return false;
    const target = state.index + step;
    return target >= 0 && target < state.entries.length;
  }
  async function go(view, step) {
    if (!can(view, step)) return false;
    const state = views.get(view), target = state.index + step, entry = state.entries[target];
    let result;
    navigating = true;
    try { result = await handlers.get(view)?.(entry, step); }
    catch { result = false; }
    finally { navigating = false; }
    if (result === null) { onChange(view); return false; }
    if (result === false || result === undefined) {
      state.entries.splice(target, 1);
      if (target < state.index) state.index--;
      onChange(view);
      return false;
    }
    state.index = target;
    onChange(view);
    return true;
  }
  // 一覧を読み直したとき（行が作り直され、前の詳細はもう開けない）。
  function reset(view) {
    if (!views.has(view)) return;
    views.delete(view);
    onChange(view);
  }
  return { handle, visit, closed, can, go, reset, back: (view) => go(view, -1), forward: (view) => go(view, 1) };
}
