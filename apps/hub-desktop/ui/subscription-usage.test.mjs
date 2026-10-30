import test from "node:test";
import assert from "node:assert/strict";
import { createSubscriptionUsageController, normalizeUsage, usageCardModel } from "./subscription-usage.mjs";

test("normalizes bounded percentages and timestamps", () => {
  const value = normalizeUsage({ agent: "codex", checkedAtMs: 1000, windows: [{ id: "w", label: "hour", usedPercent: 20, remainingPercent: 80, resetsAtMs: 2000 }] }, "codex", 3000);
  assert.equal(value.windows[0].remainingPercent, 80); assert.equal(value.windows[0].resetsAtMs, 2000);
  assert.equal(normalizeUsage({ agent: "codex", windows: [{ usedPercent: 101, remainingPercent: 0 }] }, "codex"), null);
  assert.equal(normalizeUsage({ agent: "codex", windows: [{ usedPercent: 0, remainingPercent: 100, resetsAtMs: 0 }] }, "codex", 1000).windows[0].resetsAtMs, 0);
});

test("missing provider data is retained as an unavailable result", async () => {
  const controller = createSubscriptionUsageController({ invoke: async () => ({ windows: null }) });
  await controller.refresh(); assert.equal(controller.state.records.size, 0); assert.equal(controller.state.errors.get("codex"), "unavailable");
});

test("refresh calls do not overlap", async () => {
  let calls = 0; let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const controller = createSubscriptionUsageController({ invoke: async () => { calls++; await pending; return { windows: [] }; } });
  const first = controller.refresh(); assert.equal(await controller.refresh(), false); resolve(); await first; assert.equal(calls, 2);
});

test("unsupported and timeout errors are sanitized", async () => {
  const controller = createSubscriptionUsageController({ invoke: async (_name, { agent }) => { throw new Error(agent === "claude" ? "usage unsupported" : "usage timed out"); } });
  await controller.refresh(); assert.equal(controller.state.errors.get("claude"), "unsupported"); assert.equal(controller.state.errors.get("codex"), "timeout");
});

const snapshot = () => ({ agent: "codex", checkedAtMs: 1000, windows: [{ label: "5時間", usedPercent: 20, remainingPercent: 80, resetsAtMs: 2000 }] });

test("rejects fabricated zeroes, mismatched accounts and malformed windows", () => {
  for (const used of [null, undefined, "", "0", NaN, Infinity, -Infinity, -1, 101]) {
    const data = snapshot(); data.windows[0].usedPercent = used;
    assert.equal(normalizeUsage(data, "codex", 3000), null);
  }
  for (const windows of [[], [null], [undefined], [{}], [false], ["value"], Array(65).fill(snapshot().windows[0])]) {
    assert.equal(normalizeUsage({ ...snapshot(), windows }, "codex", 3000), null);
  }
  const data = snapshot(); data.windows[0].remainingPercent = 79.5;
  assert.equal(normalizeUsage(data, "codex", 3000), null);
  assert.equal(normalizeUsage(snapshot(), "claude", 3000), null);
});

test("unknown dates remain unknown without replacing checked time with now", () => {
  for (const timestamp of [null, undefined, "1000", -1, NaN, Infinity, 8640000000000000]) {
    const data = snapshot(); data.checkedAtMs = timestamp; data.windows[0].resetsAtMs = timestamp;
    const record = normalizeUsage(data, "codex", 3000);
    const view = usageCardModel({ record });
    assert.equal(record.checkedAtMs, null);
    assert.match(view.checked, /不明/);
    assert.match(view.windows[0].reset, /不明/);
    assert.doesNotMatch(JSON.stringify(view), /Invalid Date/);
  }
  assert.equal(normalizeUsage({ ...snapshot(), checkedAtMs: 3001 }, "codex", 3000).checkedAtMs, null);
});

test("shows a completed provider while another remains pending", async () => {
  let finishClaude;
  const waiting = new Promise((resolve) => { finishClaude = resolve; });
  const views = [];
  const controller = createSubscriptionUsageController({
    now: () => 3000, render: (state) => views.push(state),
    invoke: async (_name, { agent }) => agent === "codex" ? snapshot() : waiting,
  });
  const run = controller.refresh();
  await Promise.resolve(); await Promise.resolve();
  assert(views.some((view) => view.records.has("codex") && view.pending.has("claude") && !view.pending.has("codex")));
  assert.equal(controller.state.loading, true);
  finishClaude(null); await run;
  assert.equal(controller.state.loading, false);
  assert.equal(controller.state.errors.get("claude"), "unavailable");
});

test("failed refresh retains visible original values and then recovers", async () => {
  let failure = false;
  const controller = createSubscriptionUsageController({ now: () => 3000, invoke: async (_name, { agent }) => {
    if (agent === "claude") throw "usage unsupported";
    if (failure) throw "private provider payload";
    return snapshot();
  }});
  assert.equal(controller.state.records.size, 0);
  await controller.refresh(); failure = true; await controller.refresh();
  const record = controller.state.records.get("codex");
  const stale = usageCardModel({ record, error: controller.state.errors.get("codex") });
  assert.equal(record.checkedAtMs, 1000);
  assert.match(stale.checked, /前回取得した値（古い値）/);
  assert.match(stale.status, /取得できません/);
  assert.equal(stale.windows[0].remaining, 80);
  assert.doesNotMatch(JSON.stringify(stale), /private provider payload/);
  failure = false; await controller.refresh();
  assert.equal(controller.state.errors.has("codex"), false);
  assert.doesNotMatch(usageCardModel({ record }).checked, /古い値/);
});

test("not-installed and empty responses offer recovery without fake usage", async () => {
  const controller = createSubscriptionUsageController({ invoke: async (_name, { agent }) => {
    if (agent === "codex") throw "codex not installed";
    return { agent, windows: [] };
  }});
  await controller.refresh();
  assert.equal(controller.state.records.size, 0);
  assert.match(usageCardModel({ error: controller.state.errors.get("codex") }).status, /見つかりません/);
});
