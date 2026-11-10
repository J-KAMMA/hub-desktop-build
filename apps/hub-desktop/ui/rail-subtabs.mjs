// 右列の中の小さな切り替え（DM / メール、投稿 / スレッド / グループ、おすすめ / フォロー中 / 人気）。
// 値は呼び出し側が持つ。ここは見た目と矢印キーだけ。色は rail-panels.css の意味トークンで決める。

export function createRailSubTabs(document, { label, tabs, selected, onSelect, className = "" }) {
  const nav = document.createElement("div");
  nav.className = `page-tabs rail-subtabs ${className}`.trim();
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", label);
  let current = tabs.some(([key]) => key === selected) ? selected : tabs[0][0];
  const buttons = new Map();
  const paint = () => {
    for (const [key, button] of buttons) {
      const on = key === current;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
  };
  const pick = (key, { focus = false, notify = true } = {}) => {
    if (!buttons.has(key)) return;
    const changed = key !== current;
    current = key;
    paint();
    if (focus) buttons.get(key).focus();
    if (changed && notify) onSelect?.(key);
  };
  for (const [key, text] of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rail-subtab";
    button.setAttribute("role", "tab");
    button.dataset.railSubtab = key;
    button.textContent = text;
    button.onclick = () => pick(key);
    button.onkeydown = (event) => {
      const keys = tabs.map(([k]) => k);
      const at = keys.indexOf(current);
      let next = null;
      if (event.key === "ArrowRight") next = keys[(at + 1) % keys.length];
      else if (event.key === "ArrowLeft") next = keys[(at - 1 + keys.length) % keys.length];
      else if (event.key === "Home") next = keys[0];
      else if (event.key === "End") next = keys[keys.length - 1];
      if (next === null) return;
      event.preventDefault();
      pick(next, { focus: true });
    };
    buttons.set(key, button);
    nav.append(button);
  }
  paint();
  return { element: nav, get selected() { return current; }, select: pick, set: (key) => pick(key, { notify: false }) };
}
