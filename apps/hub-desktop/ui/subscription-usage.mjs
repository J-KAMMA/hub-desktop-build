const AGENTS = [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }];
const dateValue = (value) => typeof value === "number" && Number.isInteger(value)
  && value >= 0 && value <= 253402300799000 ? value : null;
const dateLabel = (value) => value === null ? "不明" : new Date(value).toLocaleString("ja-JP", { timeZoneName: "short" });

export function normalizeUsage(value, agent, now = Date.now()) {
  if (!value || value.agent !== agent || !Array.isArray(value.windows)
    || !value.windows.length || value.windows.length > 64) return null;
  const windows = value.windows.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { usedPercent: used, remainingPercent: remaining } = item;
    if (![used, remaining].every(Number.isFinite) || used < 0 || used > 100
      || remaining < 0 || remaining > 100 || Math.abs(used + remaining - 100) > 0.000001) return null;
    return {
      label: typeof item.label === "string" && item.label.trim() ? item.label.slice(0, 200) : "利用枠",
      usedPercent: used, remainingPercent: remaining, resetsAtMs: dateValue(item.resetsAtMs),
    };
  });
  const checked = dateValue(value.checkedAtMs);
  return windows.every(Boolean) ? { agent, windows, checkedAtMs: checked !== null && checked <= now ? checked : null } : null;
}

function errorKind(error) {
  const message = typeof error === "string" ? error : error?.message;
  if (message === "usage unsupported") return "unsupported";
  if (message === "usage timed out") return "timeout";
  if (message === "codex not installed") return "not-installed";
  return "unavailable";
}

export function createSubscriptionUsageController({ invoke, render = () => {}, now = () => Date.now() }) {
  const state = { records: new Map(), errors: new Map(), pending: new Set(), loading: false };
  const redraw = () => render({ ...state, records: new Map(state.records), errors: new Map(state.errors), pending: new Set(state.pending) });
  async function refresh() {
    if (state.loading) return false;
    state.loading = true;
    state.pending = new Set(AGENTS.map(({ id }) => id));
    redraw();
    try {
      await Promise.all(AGENTS.map(async ({ id }) => {
        try {
          const record = normalizeUsage(await invoke("desktop_agent_usage", { agent: id }), id, now());
          if (!record) throw "usage unavailable";
          state.records.set(id, record);
          state.errors.delete(id);
        } catch (error) {
          state.errors.set(id, errorKind(error));
        } finally {
          state.pending.delete(id);
          redraw();
        }
      }));
    } finally {
      state.loading = false;
      redraw();
    }
    return true;
  }
  redraw();
  return { state, refresh };
}

export function usageCardModel({ record, error, pending }) {
  const problem = {
    unsupported: "自動取得は未対応。Claude Codeで /usage を開いて確認してください。",
    timeout: "取得がタイムアウトしました。再度更新してください。",
    "not-installed": "Codexが見つかりません。この端末のCodex CLIを確認してください。",
    unavailable: "使用量を取得できません。CLIのログイン状態と接続を確認して、再度更新してください。",
  }[error];
  return {
    status: pending ? "確認中…" : problem ?? (record ? "取得済み" : "未取得"),
    warning: Boolean(error && error !== "unsupported"),
    checked: record ? "確認 " + dateLabel(record.checkedAtMs) + (error ? " · 前回取得した値（古い値）" : "") : null,
    windows: (record?.windows ?? []).map((item) => ({
      label: item.label + " · 使用 " + Math.round(item.usedPercent) + "% / 残り " + Math.round(item.remainingPercent) + "%",
      remaining: item.remainingPercent,
      reset: "リセット " + dateLabel(item.resetsAtMs),
    })),
  };
}

export function initSubscriptionUsage({ invoke, document = globalThis.document }) {
  if (!document.querySelector("#subscription-usage")) return null;
  const list = document.querySelector("#subscription-usage-list");
  const refreshButton = document.querySelector("#subscription-usage-refresh");
  const node = (tag, text, className = "") => Object.assign(document.createElement(tag), { textContent: text, className });
  const controller = createSubscriptionUsageController({ invoke, render: ({ records, loading, errors, pending }) => {
    refreshButton.disabled = loading;
    refreshButton.textContent = loading ? "確認中…" : "更新";
    list.setAttribute("aria-busy", String(loading));
    list.replaceChildren(...AGENTS.map(({ id, label }) => {
      const view = usageCardModel({ record: records.get(id), error: errors.get(id), pending: pending.has(id) });
      const card = node("article", "", "card agent-card");
      card.append(node("strong", label), node("p", view.status, "meta" + (view.warning ? " warning" : "")));
      if (view.checked) card.append(node("p", view.checked, "meta"));
      card.append(...view.windows.map((item) => {
        const row = node("div", "", "usage-row");
        const meter = document.createElement("progress");
        meter.max = 100;
        meter.value = item.remaining;
        meter.setAttribute("aria-label", item.label);
        row.append(node("span", item.label), meter, node("small", item.reset));
        return row;
      }));
      return card;
    }));
  }});
  refreshButton.onclick = () => void controller.refresh();
  return controller;
}
