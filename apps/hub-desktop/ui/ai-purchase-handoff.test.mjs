import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { purchaseProposal, resolvePurchaseHandoff } from "./ai-purchase-handoff.mjs";
import { createPiWorkController, piWorkErrorText } from "./pi-work.mjs";
import { renderPiApproval } from "./pi-approval.mjs";

const ID = "8f14e45f-ceea-467a-9575-1f3b1c5a2d11";
const pay = (detail = { productId: ID, quantity: 2 }) => ({ id: "pay", tool: "hub_pay", summary: `purchase product ${ID} ×2 — 補充用`, detail });
const run = (action = pay()) => ({ id: "r1", workspace: "C:/w", model: "m", prompt: "p", status: "running", toolCalls: [], agentEvents: 0, pendingActions: [action] });
const timers = { setInterval: () => 1, clearInterval() {} };
const FORBIDDEN = /order_|payment|wallet|sign|checkout_submit/;

test("proposal validation is strict", () => {
  assert.deepEqual(purchaseProposal(pay()), { productId: ID, quantity: 2 });
  for (const detail of [null, {}, { productId: "x", quantity: 1 }, { productId: ID, quantity: 0 }, { productId: ID, quantity: 21 }, { productId: ID, quantity: 1.5 }, { productId: ID, quantity: "2" }, { productId: `${ID}/../x`, quantity: 1 }])
    assert.equal(purchaseProposal(pay(detail)), null);
  assert.equal(purchaseProposal({ ...pay(), tool: "hub_exec" }), null);
});

test("approve opens the product with the quantity and resolves handed_to_checkout only", async () => {
  const calls = [], opened = [];
  const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run(); }, timers, purchaseHandoff: async (p) => { opened.push(p); return true; } });
  controller.state.runs = [run()];
  assert.equal(await controller.decide("r1", "pay", true), true);
  assert.deepEqual(opened, [{ productId: ID, quantity: 2 }]);
  assert.deepEqual(calls, [["pi_work_decide", { runId: "r1", actionId: "pay", approve: true, outcome: { status: "handed_to_checkout", productId: ID, quantity: 2 } }]]);
  assert.ok(calls.every(([name]) => !FORBIDDEN.test(name)));
  controller.dispose();
});

test("invalid id fails closed: no screen opened, decision is a denial", async () => {
  const calls = [], opened = [];
  const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run({ ...pay(), id: "gone" }); }, timers, purchaseHandoff: async (p) => { opened.push(p); return true; } });
  controller.state.runs = [run(pay({ productId: "../../x", quantity: 1 }))];
  assert.equal(await controller.decide("r1", "pay", true), false);
  assert.deepEqual(opened, []);
  assert.deepEqual(calls, [["pi_work_decide", { runId: "r1", actionId: "pay", approve: false }]]);
  assert.match(piWorkErrorText(controller.state.error), /拒否しました/);
  controller.dispose();
});

test("failed or throwing product open denies instead of claiming a handoff", async () => {
  for (const open of [async () => false, async () => { throw new Error("commerce_product_unavailable"); }]) {
    const calls = [];
    const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run(); }, timers, purchaseHandoff: open });
    controller.state.runs = [run()];
    assert.equal(await controller.decide("r1", "pay", true), false);
    assert.deepEqual(calls, [["pi_work_decide", { runId: "r1", actionId: "pay", approve: false }]]);
    assert.equal(controller.state.busy, false);
    controller.dispose();
  }
  assert.deepEqual(await resolvePurchaseHandoff(pay(), undefined), { approve: false, error: "purchase_proposal_invalid" });
});

test("deny is unchanged and never opens a screen", async () => {
  const calls = []; let opened = 0;
  const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run(); }, timers, purchaseHandoff: async () => { opened++; return true; } });
  controller.state.runs = [run()];
  assert.equal(await controller.decide("r1", "pay", false), true);
  assert.equal(opened, 0);
  assert.deepEqual(calls, [["pi_work_decide", { runId: "r1", actionId: "pay", approve: false }]]);
  controller.dispose();
});

test("approval card labels the action as opening the purchase screen", () => {
  const { JSDOM } = createRequire(new URL("../../../package.json", import.meta.url))("jsdom");
  const dom = new JSDOM("<main></main>"), decisions = [];
  const root = renderPiApproval({ document: dom.window.document, run: { id: "r1", model: "m", workspace: "w" }, action: pay(), onDecide: (...a) => decisions.push(a) });
  assert.equal(root.querySelector(".approve").textContent, "購入画面を開く");
  assert.match(root.textContent, new RegExp(ID));
  assert.match(root.textContent, /補充用/);
  assert.match(root.textContent, /支払いや署名は行いません/);
  root.querySelector(".approve").click();
  assert.deepEqual(decisions, [["r1", "pay", true]]);
  const bad = renderPiApproval({ document: dom.window.document, run: { id: "r1" }, action: pay({ productId: "x", quantity: 1 }), onDecide() {} });
  assert.equal(bad.querySelector(".approve").disabled, true);
  dom.window.close();
});
