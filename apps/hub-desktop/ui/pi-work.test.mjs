import test from "node:test";
import assert from "node:assert/strict";
import {
  bestOfEstimate, buildPiWorkRequest, createPiWorkController, isMissingCommandError, PI_BEST_OF_TOKEN_CAP,
  hubWorkHistoryEntries, pendingActionsOf, piWorkErrorText, piWorkEventText, piWorkIsTerminal,
  piWorkStatusLabel, toolCallsOf
} from "./pi-work.mjs";

const run = (extra = {}) => ({ id: "r1", workspace: "C:/w", model: "ollama/qwen2.5:1.5b", prompt: "調べて", status: "running", toolCalls: [], agentEvents: 0, ...extra });

test("status labels cover the run lifecycle and fall back safely", () => {
  assert.equal(piWorkStatusLabel("running"), "実行中");
  assert.equal(piWorkStatusLabel("done"), "返答終了");
  assert.equal(piWorkStatusLabel("done", { status: "passed" }), "指定検証に合格");
  assert.equal(piWorkStatusLabel("failed"), "失敗");
  assert.equal(piWorkStatusLabel("cancelled"), "中断");
  assert.equal(piWorkStatusLabel("unexpected"), "unexpected");
  for (const status of ["done", "failed", "cancelled"]) assert.equal(piWorkIsTerminal(status), true);
  for (const status of ["running", "awaiting_approval", ""]) assert.equal(piWorkIsTerminal(status), false);
});

test("Hub history orders built-in and CLI runs together without dropping either source", () => {
  const entries = hubWorkHistoryEntries([{ id: "h1", startedAtMs: 10 }, { id: "h2", startedAtMs: 30 }], [{ id: "c1", startedAtMs: 20 }]);
  assert.deepEqual(entries.map(({ kind, run }) => `${kind}:${run.id}`), ["hub:h2", "cli:c1", "hub:h1"]);
  assert.deepEqual(hubWorkHistoryEntries(null, undefined), []);
});

test("tool call text marks unsettled calls as running, not failed", () => {
  assert.equal(piWorkEventText({ name: "hub_read" }), "hub_read · 実行中");
  assert.equal(piWorkEventText({ name: "hub_write", ok: true }), "hub_write · 成功");
  assert.equal(piWorkEventText({ name: "hub_write", ok: false }), "hub_write · 失敗");
});

test("a valid form maps to start args without a script override", () => {
  const request = buildPiWorkRequest({ workspace: " C:\\work ", prompt: "依頼", model: " ollama/m:1b ", allowWrite: true });
  assert.deepEqual(request, { workspace: "C:\\work", prompt: "依頼", allowWrite: true, allowExec: false, allowHttp: false, model: "ollama/m:1b", engine: "thin" });
  assert.equal(Object.hasOwn(request, "script"), false);
});

test("empty workspace and prompt are rejected with Japanese guidance", () => {
  assert.throws(() => buildPiWorkRequest({ workspace: "", prompt: "x" }), /作業フォルダを設定してください/);
  assert.throws(() => buildPiWorkRequest({ workspace: "   ", prompt: "x" }), /作業フォルダを設定してください/);
  assert.throws(() => buildPiWorkRequest({ workspace: "C:/w", prompt: "  " }), /依頼内容を入力してください/);
  assert.throws(() => buildPiWorkRequest({ workspace: "C:/w" }), /依頼内容を入力してください/);
});

test("prompt length is bounded by characters, matching the backend cap", () => {
  const base = { workspace: "C:/w" };
  assert.equal(buildPiWorkRequest({ ...base, prompt: "あ".repeat(8000) }).prompt.length, 8000);
  assert.throws(() => buildPiWorkRequest({ ...base, prompt: "あ".repeat(8001) }), /8000文字/);
  // Surrogate pairs count once, like Rust's chars().count().
  assert.throws(() => buildPiWorkRequest({ ...base, prompt: "𠮷".repeat(8001) }), /8000文字/);
});

test("empty model is omitted so the backend default applies; allowWrite stays boolean", () => {
  const minimal = buildPiWorkRequest({ workspace: "C:/w", prompt: "p", model: "   " });
  assert.equal(Object.hasOwn(minimal, "model"), false);
  assert.equal(minimal.allowWrite, false);
  assert.equal(buildPiWorkRequest({ workspace: "C:/w", prompt: "p", allowWrite: 1 }).allowWrite, true);
});

test("operator verification is passed as program and argv only when command execution is enabled", () => {
  const base = { workspace: "C:/w", prompt: "fix it" };
  assert.deepEqual(buildPiWorkRequest({ ...base, allowExec: true, verifyProgram: " node ", verifyArgs: "verify.cjs\r\n--strict" }).verification,
    { program: "node", args: ["verify.cjs", "--strict"] });
  assert.equal(Object.hasOwn(buildPiWorkRequest(base), "verification"), false);
  assert.throws(() => buildPiWorkRequest({ ...base, verifyProgram: "node" }), /コマンド実行を有効/);
  assert.throws(() => buildPiWorkRequest({ ...base, allowExec: true, verifyArgs: "verify.cjs" }), /プログラムを入力/);
});

test("best-of-N needs a confirmed N-attempt estimate and a declared verification", () => {
  const base = { workspace: "C:/w", prompt: "fix it", allowExec: true, verifyProgram: "node", verifyArgs: "verify.cjs" };
  assert.equal(bestOfEstimate(""), null);
  assert.equal(bestOfEstimate("1"), null);
  assert.equal(bestOfEstimate("4"), null);
  const estimate = bestOfEstimate("3");
  assert.equal(estimate.maxTokens, 3 * PI_BEST_OF_TOKEN_CAP);
  assert.match(estimate.text, /3回試行：最大 1,500,000 トークン/);
  assert.deepEqual(buildPiWorkRequest({ ...base, bestOf: "3", bestOfConfirmed: true }).bestOf,
    { attempts: 3, tokenCap: PI_BEST_OF_TOKEN_CAP, estimateTokens: 3 * PI_BEST_OF_TOKEN_CAP });
  assert.throws(() => buildPiWorkRequest({ ...base, bestOf: "2" }), /見積りを確認/);
  assert.throws(() => buildPiWorkRequest({ ...base, bestOf: "2", bestOfConfirmed: true, verifyProgram: "" , verifyArgs: "" }), /検証コマンドが必要/);
  assert.throws(() => buildPiWorkRequest({ ...base, bestOf: "2", bestOfConfirmed: true, resumeRunId: "r" }), /新しい作業でだけ/);
  assert.equal(Object.hasOwn(buildPiWorkRequest({ ...base, bestOfConfirmed: true }), "bestOf"), false);
  assert.match(piWorkErrorText("best_of_none_passed"), /作業フォルダは変更していません/);
});

test("allowed fast checkers are passed as argv only with command execution", () => {
  const checker = { program: "cargo", args: ["check", "--offline"] };
  const base = { workspace: "C:/w", prompt: "fix it", checkers: [checker] };
  assert.deepEqual(buildPiWorkRequest({ ...base, allowExec: true }).checkers, [checker]);
  assert.throws(() => buildPiWorkRequest(base), /コマンド実行を有効/);
  assert.equal(Object.hasOwn(buildPiWorkRequest({ workspace: "C:/w", prompt: "x", allowExec: true }), "checkers"), false);
});

test("a new run always sends thin; the retired standard engine (pi) is never sent", () => {
  for (const engine of [undefined, "thin", "pi", "dsh", "rm -rf", ""]) {
    assert.equal(buildPiWorkRequest({ workspace: "C:/w", prompt: "x", engine }).engine, "thin", String(engine));
  }
  for (const engine of ["pi", "thin", undefined, "bogus"]) {
    assert.notEqual(buildPiWorkRequest({ workspace: "C:/w", prompt: "x", resumeRunId: "r", engine }).engine, "pi", String(engine));
  }
  assert.match(piWorkErrorText("standard_engine_retired"), /旧方式のため再開できません/);
});

test("continuation keeps its conversation engine without inheriting tool permissions", () => {
  const request = buildPiWorkRequest({ workspace: "C:/w", prompt: "続けて", resumeRunId: "previous", engine: "dsh" });
  assert.equal(request.resumeRunId, "previous");
  assert.equal(request.engine, "dsh");
  assert.equal(request.allowWrite, false);
  assert.equal(request.allowExec, false);
  assert.equal(request.allowHttp, false);
  assert.equal(Object.hasOwn(request, "verification"), false);
  assert.equal(Object.hasOwn(buildPiWorkRequest({ workspace: "C:/w", prompt: "新規" }), "resumeRunId"), false);
});

test("absent or malformed optional fields degrade to empty lists", () => {
  for (const view of [null, {}, { pendingActions: "x" }, run()]) assert.deepEqual(pendingActionsOf(view), []);
  assert.equal(pendingActionsOf(run({ pendingActions: [{ id: "a1" }] })).length, 1);
  for (const view of [null, {}, { toolCalls: 1 }]) assert.deepEqual(toolCallsOf(view), []);
});

test("missing-command detection excludes the domain not-found errors", () => {
  assert.equal(isMissingCommandError("unknown command"), true);
  assert.equal(isMissingCommandError("command pi_work_decide not found"), true);
  assert.equal(isMissingCommandError("pi_work_not_found"), false);
  assert.equal(isMissingCommandError("pi_action_not_found"), false);
});

test("known backend error strings map to Japanese explanations", () => {
  assert.match(piWorkErrorText("workspace_not_found"), /作業フォルダ/);
  assert.match(piWorkErrorText("prompt_empty"), /依頼内容を入力/);
  assert.match(piWorkErrorText("required_verification_not_passed"), /検証コマンドが合格していません/);
  assert.match(piWorkErrorText("legacy_engine_requires_resume"), /新しい作業は Pi の道具の方式/);
  assert.match(piWorkErrorText("pi_session_workspace_mismatch"), /作業フォルダが異なります/);
  assert.match(piWorkErrorText("run already in progress"), /進行中/);
  assert.equal(piWorkErrorText("some other failure"), "some other failure");
});

function fakeTimers() {
  const active = new Map();
  let next = 1;
  return {
    active,
    setInterval: (fn, ms) => { const id = next++; active.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { active.delete(id); }
  };
}

test("start builds the request from the live workspace and selects the run", async () => {
  const calls = [];
  const timers = fakeTimers();
  const controller = createPiWorkController({
    invoke: async (name, args) => { calls.push([name, args]); return name === "pi_work_start" ? run({ id: "new" }) : []; },
    getWorkspace: () => "C:/shared",
    timers
  });
  assert.equal(await controller.start({ prompt: " 依頼 ", model: "", allowWrite: false }), true);
  assert.deepEqual(calls[0], ["pi_work_start", { workspace: "C:/shared", prompt: "依頼", allowWrite: false, allowExec: false, allowHttp: false, engine: "thin" }]);
  assert.equal(controller.state.selectedId, "new");
  assert.equal(controller.state.runs[0].id, "new");
  // The fresh run is live, so the poll loop is now running.
  assert.equal(timers.active.size, 1);
  controller.dispose();
});

test("start validates before invoking and keeps the error visible", async () => {
  let invoked = false;
  const controller = createPiWorkController({ invoke: async () => { invoked = true; }, getWorkspace: () => "" });
  assert.equal(await controller.start({ prompt: "p" }), false);
  assert.equal(invoked, false);
  assert.match(controller.state.error, /作業フォルダ/);
});

test("approve sends runId, actionId and approve to pi_work_decide", async () => {
  const calls = [];
  const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run({ pendingActions: [{ id: "a1" }] }); }, timers: fakeTimers() });
  controller.state.runs = [run({ pendingActions: [{ id: "a1", tool: "hub_write", detail: { path: "new.txt", before: "", after: "hello" } }] })];
  assert.equal(await controller.decide("r1", "a1", true), true);
  assert.deepEqual(calls, [["pi_work_decide", { runId: "r1", actionId: "a1", approve: true }]]);
  // One shot per action: a repeated click is not a second approval.
  assert.equal(await controller.decide("r1", "a1", true), false);
  assert.equal(calls.length, 1);
});

test("decide refuses stale actions and terminal runs", async () => {
  const calls = [];
  const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run(); } });
  controller.state.runs = [run({ pendingActions: [{ id: "a1" }] })];
  assert.equal(await controller.decide("r1", "gone", true), false);
  assert.equal(await controller.decide("missing", "a1", true), false);
  controller.state.runs = [run({ status: "done", pendingActions: [{ id: "a1" }] })];
  assert.equal(await controller.decide("r1", "a1", true), false);
  assert.deepEqual(calls, []);
});

test("file approval requires a full preview but denial does not", async () => {
  for (const tool of ["hub_write", "hub_edit"]) {
    for (const detail of [null, {}, { path: "a", before: "" }, { path: "a", before: "", after: null }]) {
      const calls = [];
      const controller = createPiWorkController({ invoke: async (name, args) => { calls.push(args); return run(); }, timers: fakeTimers() });
      controller.state.runs = [run({ pendingActions: [{ id: "a1", tool, detail }] })];
      assert.equal(await controller.decide("r1", "a1", true), false);
      assert.deepEqual(calls, []);
      assert.equal(await controller.decide("r1", "a1", false), true);
      assert.deepEqual(calls, [{ runId: "r1", actionId: "a1", approve: false }]);
    }
  }
});

test("purchase approval fails closed locally while denial and other tool approvals still dispatch", async () => {
  const calls = [];
  const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run(); }, timers: fakeTimers() });
  controller.state.runs = [run({ pendingActions: [{ id: "pay", tool: "hub_pay" }] })];
  assert.equal(await controller.decide("r1", "pay", true), false);
  assert.deepEqual(calls, []);
  assert.equal(controller.state.runs[0].pendingActions.length, 1);
  assert.equal(controller.state.busy, false);
  assert.equal(controller.state.decideSupported, true);
  assert.match(piWorkErrorText(controller.state.error), /マーケット/);
  assert.equal(await controller.decide("r1", "pay", false), true);
  assert.deepEqual(calls, [["pi_work_decide", { runId: "r1", actionId: "pay", approve: false }]]);
  controller.state.runs = [run({ pendingActions: [{ id: "exec", tool: "hub_exec" }] })];
  assert.equal(await controller.decide("r1", "exec", true), true);
  assert.deepEqual(calls.at(-1), ["pi_work_decide", { runId: "r1", actionId: "exec", approve: true }]);
  assert.match(piWorkErrorText("purchase_outcome_missing"), /購入済みとして扱えません/);
  controller.dispose();
});

test("a backend without pi_work_decide hides approvals from then on", async () => {
  const controller = createPiWorkController({ invoke: async () => { throw new Error("command pi_work_decide not found"); } });
  controller.state.runs = [run({ pendingActions: [{ id: "a1" }] })];
  assert.equal(controller.state.decideSupported, true);
  assert.equal(await controller.decide("r1", "a1", true), false);
  assert.equal(controller.state.decideSupported, false);
  assert.equal(await controller.decide("r1", "a1", true), false);
});

test("a domain error from pi_work_decide does not disable the feature", async () => {
  const controller = createPiWorkController({ invoke: async () => { throw new Error("pi_action_not_found"); } });
  controller.state.runs = [run({ pendingActions: [{ id: "a1" }] })];
  assert.equal(await controller.decide("r1", "a1", false), false);
  assert.equal(controller.state.decideSupported, true);
  assert.match(controller.state.error, /pi_action_not_found/);
});

test("cancel targets the selected live run and ignores terminal or unknown ids", async () => {
  const calls = [];
  const controller = createPiWorkController({ invoke: async (name, args) => { calls.push([name, args]); return run({ status: "cancelled" }); } });
  controller.state.runs = [run()];
  assert.equal(await controller.cancel("missing"), false);
  assert.equal(await controller.cancel("r1"), true);
  assert.deepEqual(calls, [["pi_work_cancel", { id: "r1" }]]);
  assert.equal(controller.state.runs[0].status, "cancelled");
  assert.equal(await controller.cancel("r1"), false);
  assert.equal(calls.length, 1);
});

test("the poll loop slows to a discovery cadence when idle, then re-accelerates", async () => {
  const timers = fakeTimers();
  let listed = run();
  const controller = createPiWorkController({ invoke: async () => [listed], timers, pollIntervalMs: 1500, idlePollIntervalMs: 5000 });
  assert.equal(timers.active.size, 0);
  await controller.load();
  assert.equal(timers.active.size, 1);
  assert.equal(timers.active.get(1).ms, 1500);
  listed = run({ status: "done" });
  assert.equal(await controller.poll(), false);
  // All terminal: the loop keeps polling slowly so a run started outside
  // this window still surfaces — including its pending approvals.
  assert.equal(timers.active.size, 1);
  assert.equal(timers.active.get(2).ms, 5000);
  listed = run({ id: "ext" });
  assert.equal(await controller.poll(), true);
  assert.equal(timers.active.size, 1);
  assert.equal(timers.active.get(3).ms, 1500);
  controller.dispose();
  assert.equal(timers.active.size, 0);
});

test("load keeps an explicit selection and falls back to a live run", async () => {
  const controller = createPiWorkController({ invoke: async () => [run({ id: "old", status: "done" }), run({ id: "live" })], timers: fakeTimers() });
  await controller.load();
  assert.equal(controller.state.selectedId, "live");
  controller.select("old");
  await controller.load();
  assert.equal(controller.state.selectedId, "old");
  controller.dispose();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("load during start neither unlocks busy nor invalidates its result", async () => {
  const pending = deferred(), timers = fakeTimers(), calls = [];
  const controller = createPiWorkController({
    invoke: (name) => { calls.push(name); return name === "pi_work_start" ? pending.promise : Promise.resolve([]); },
    getWorkspace: () => "C:/live", timers
  });
  const started = controller.start({ prompt: "work" });
  try {
    await controller.load();
    assert.equal(controller.state.busy, true);
    assert.equal(await controller.start({ prompt: "duplicate" }), false);
    pending.resolve(run({ id: "started" }));
    assert.equal(await started, true);
    assert.equal(controller.state.selectedId, "started");
    assert.equal(controller.state.busy, false);
    assert.equal(calls.filter(name => name === "pi_work_start").length, 1);
  } finally { pending.resolve(run()); await started; controller.dispose(); }
});

test("a poll failure cannot unlock a pending approval decision", async () => {
  const pending = deferred(), timers = fakeTimers(), calls = [];
  const controller = createPiWorkController({
    invoke: (name) => { calls.push(name); return name === "pi_work_decide" ? pending.promise : Promise.reject(new Error("read_failed")); }, timers
  });
  controller.state.runs = [run({ pendingActions: [{ id: "a1" }] })];
  const decided = controller.decide("r1", "a1", true);
  try {
    await controller.poll();
    assert.equal(controller.state.busy, true);
    assert.equal(controller.state.error, null);
    assert.equal(await controller.cancel("r1"), false);
    pending.resolve(run({ pendingActions: [] }));
    assert.equal(await decided, true);
    assert.deepEqual(calls.filter(name => name !== "pi_work_list"), ["pi_work_decide"]);
  } finally { pending.resolve(run()); await decided; controller.dispose(); }
});

test("dispose during cancel prevents late rendering and timer resurrection", async () => {
  const pending = deferred(), timers = fakeTimers(), views = [];
  const controller = createPiWorkController({ invoke: () => pending.promise, render: view => views.push(view), timers });
  controller.state.runs = [run()];
  const cancelled = controller.cancel("r1");
  controller.dispose();
  const snapshot = structuredClone(controller.state), rendered = views.length;
  pending.resolve(run({ status: "cancelled" }));
  assert.equal(await cancelled, false);
  assert.deepEqual(controller.state, snapshot);
  assert.equal(views.length, rendered);
  assert.equal(timers.active.size, 0);
});

function seedAction(controller) {
  controller.state.runs = [run({ pendingActions: [{ id: "a1" }] })];
  controller.state.selectedId = "r1";
}
const mutation = (controller, name) => name === "start" ? controller.start({ prompt: "work" })
  : name === "cancel" ? controller.cancel("r1") : controller.decide("r1", "a1", false);

test("reads begun before mutations are ignored whether they settle before or after the mutation", async () => {
  for (const method of ["load", "poll"]) for (const name of ["start", "cancel", "decide"]) for (const readFirst of [true, false]) {
    const reading = deferred(), writing = deferred(), timers = fakeTimers(), calls = [];
    const controller = createPiWorkController({
      invoke: (command, args) => { calls.push([command, args]); return command === "pi_work_list" ? reading.promise : writing.promise; },
      getWorkspace: () => "C:/live", timers
    });
    seedAction(controller);
    const observed = controller[method](), changed = mutation(controller, name);
    const initial = structuredClone(controller.state.runs);
    if (readFirst) {
      reading.resolve([run({ id: "stale", status: "done" })]); await observed;
      assert.equal(controller.state.busy, true);
      assert.deepEqual(controller.state.runs, initial);
    }
    writing.resolve(run({ id: name === "start" ? "new" : "r1", status: name === "cancel" ? "cancelled" : "running", pendingActions: [] }));
    assert.equal(await changed, true);
    const settled = structuredClone(controller.state);
    if (!readFirst) { reading.resolve([run({ id: "stale" })]); await observed; }
    assert.deepEqual(controller.state, settled);
    assert.equal(calls.length, 2);
    controller.dispose();
  }
});

test("an already in-flight poll rejection cannot settle a mutation or release its action guard", async () => {
  const reading = deferred(), writing = deferred(), timers = fakeTimers(), calls = [];
  const controller = createPiWorkController({ invoke: command => { calls.push(command); return command === "pi_work_list" ? reading.promise : writing.promise; }, timers });
  seedAction(controller);
  const observed = controller.poll(), changed = controller.decide("r1", "a1", true);
  reading.reject(new Error("old_read_failed")); await observed;
  assert.equal(controller.state.busy, true);
  assert.equal(controller.state.error, null);
  assert.equal(await controller.decide("r1", "a1", false), false);
  assert.equal(await controller.cancel("r1"), false);
  writing.resolve(run({ pendingActions: [] }));
  assert.equal(await changed, true);
  assert.deepEqual(calls, ["pi_work_list", "pi_work_decide"]);
  controller.dispose();
});

test("busy mutations suppress both manual observation calls without changing selection or errors", async () => {
  for (const name of ["start", "cancel", "decide"]) {
    const pending = deferred(), calls = [], timers = fakeTimers();
    const controller = createPiWorkController({ invoke: command => { calls.push(command); return pending.promise; }, getWorkspace: () => "C:/live", timers });
    seedAction(controller);
    const changed = mutation(controller, name), before = structuredClone(controller.state);
    assert.equal(await controller.load(), controller.state);
    assert.equal(await controller.poll(), false);
    assert.deepEqual(controller.state, before);
    assert.equal(await controller.start({ prompt: "duplicate" }), false);
    assert.equal(await controller.cancel("r1"), false);
    assert.equal(await controller.decide("r1", "a1", true), false);
    assert.equal(calls.length, 1);
    pending.resolve(run()); await changed; controller.dispose();
  }
});

test("the newest read owns the result across load and poll, including stale read failures", async () => {
  for (const first of ["load", "poll"]) for (const second of ["load", "poll"]) for (const rejectOld of [false, true]) {
    const old = deferred(), latest = deferred(), timers = fakeTimers(), queue = [old, latest];
    const controller = createPiWorkController({ invoke: () => queue.shift().promise, timers });
    const firstRead = controller[first](), secondRead = controller[second]();
    latest.resolve([run({ id: "latest" })]); await secondRead;
    controller.select("latest");
    if (rejectOld) old.reject(new Error("stale_error")); else old.resolve([run({ id: "old" })]);
    await firstRead;
    assert.equal(controller.state.runs[0].id, "latest");
    assert.equal(controller.state.selectedId, "latest");
    assert.equal(controller.state.error, null);
    assert.equal(timers.active.size, 1);
    controller.dispose();
  }
});

test("a newest read failure cannot be cleared by an older successful response", async () => {
  const old = deferred(), latest = deferred(), timers = fakeTimers(), queue = [old, latest];
  const controller = createPiWorkController({ invoke: () => queue.shift().promise, timers });
  seedAction(controller);
  const initial = structuredClone(controller.state.runs);
  const oldRead = controller.load(), newRead = controller.poll();
  latest.reject(new Error("current_read_failed")); await newRead;
  old.resolve([run({ id: "old" })]); await oldRead;
  assert.deepEqual(controller.state.runs, initial);
  assert.match(controller.state.error, /current_read_failed/);
  assert.equal(controller.state.busy, false);
  controller.dispose();
});

test("mutation errors retain the live run and require a new explicit call to retry", async () => {
  for (const name of ["start", "cancel", "decide"]) {
    const reading = deferred(), writing = deferred(), calls = [], timers = fakeTimers();
    const controller = createPiWorkController({ invoke: command => { calls.push(command); return command === "pi_work_list" ? reading.promise : writing.promise; }, getWorkspace: () => "C:/live", timers });
    seedAction(controller);
    const initial = structuredClone(controller.state.runs), observed = controller.poll(), changed = mutation(controller, name);
    writing.reject(new Error("native_mutation_failed"));
    assert.equal(await changed, false);
    assert.equal(controller.state.busy, false);
    assert.match(controller.state.error, /native_mutation_failed/);
    assert.deepEqual(controller.state.runs, initial);
    reading.resolve([run({ status: "done" })]); await observed;
    assert.match(controller.state.error, /native_mutation_failed/);
    assert.deepEqual(controller.state.runs, initial);
    assert.equal(calls.length, 2);
    controller.dispose();
  }
});

test("disposal is terminal for every late success and failure and every public entry point", async () => {
  for (const method of ["load", "poll", "start", "cancel", "decide"]) for (const reject of [false, true]) {
    const pending = deferred(), views = [], calls = [], timers = fakeTimers();
    const controller = createPiWorkController({ invoke: command => { calls.push(command); return pending.promise; }, render: view => views.push(view), getWorkspace: () => "C:/live", timers });
    seedAction(controller);
    const inFlight = ["load", "poll"].includes(method) ? controller[method]() : mutation(controller, method);
    controller.dispose();
    const snapshot = structuredClone(controller.state), rendered = views.length;
    if (reject) pending.reject(new Error("command pi_work_decide not found")); else pending.resolve(["load", "poll"].includes(method) ? [run({ id: "late" })] : run({ status: "cancelled" }));
    await inFlight;
    assert.deepEqual(controller.state, snapshot);
    controller.select("changed"); controller.refresh(); controller.dispose();
    await controller.load(); assert.equal(await controller.poll(), false);
    assert.equal(await controller.start({ prompt: "again" }), false);
    assert.equal(await controller.cancel("r1"), false);
    assert.equal(await controller.decide("r1", "a1", true), false);
    assert.deepEqual(controller.state, snapshot);
    assert.equal(views.length, rendered);
    assert.equal(timers.active.size, 0);
    assert.equal(calls.length, 1);
  }
});

test("disposal from the busy render or live workspace getter prevents command dispatch", async () => {
  for (const name of ["start", "cancel", "decide"]) {
    let controller;
    const calls = [];
    controller = createPiWorkController({ invoke: command => { calls.push(command); return Promise.resolve(run()); }, render: view => { if (view.busy) controller.dispose(); }, getWorkspace: () => "C:/live", timers: fakeTimers() });
    seedAction(controller);
    assert.equal(await mutation(controller, name), false);
    assert.deepEqual(calls, []);
  }
  let controller, called = false;
  controller = createPiWorkController({ invoke: () => { called = true; }, getWorkspace: () => { controller.dispose(); return "C:/live"; } });
  assert.equal(await controller.start({ prompt: "work" }), false);
  assert.equal(called, false);
});

test("queued timer callbacks cannot poll during a mutation or after disposal", async () => {
  const writing = deferred(), reading = deferred(), timers = fakeTimers(), calls = [];
  let firstList = true;
  const controller = createPiWorkController({
    invoke: command => { calls.push(command); if (command !== "pi_work_list") return writing.promise; if (firstList) { firstList = false; return Promise.resolve([run()]); } return reading.promise; },
    getWorkspace: () => "C:/live", timers
  });
  await controller.load();
  const tick = [...timers.active.values()][0].fn;
  const changed = controller.start({ prompt: "work" });
  tick(); tick();
  assert.equal(calls.length, 2);
  writing.resolve(run({ id: "new" })); await changed;
  tick(); tick();
  assert.equal(calls.length, 3);
  controller.dispose(); tick();
  const before = structuredClone(controller.state);
  reading.resolve([run({ id: "late" })]);
  await new Promise(setImmediate);
  assert.deepEqual(controller.state, before);
  assert.equal(calls.length, 3);
  assert.equal(timers.active.size, 0);
});

test("malformed mutation responses fail explicitly without inventing a result or retrying", async () => {
  for (const name of ["start", "cancel", "decide"]) for (const response of [null,undefined,{},[],{id:undefined},{id:""},{id:42}]) {
    const calls = [], timers = fakeTimers();
    const controller = createPiWorkController({ invoke: command => { calls.push(command); return Promise.resolve(response); }, getWorkspace: () => "C:/live", timers });
    seedAction(controller);
    const initial = structuredClone(controller.state.runs);
    assert.equal(await mutation(controller,name),false);
    assert.equal(controller.state.busy,false);
    assert.match(controller.state.error,/応答を確認できません/);
    assert.deepEqual(controller.state.runs,initial);
    assert.equal(controller.state.selectedId,"r1");
    assert.equal(calls.length,1);
    assert.equal(timers.active.size,0);
    controller.dispose();
  }
});

test("valid older mutation views and unknown status displays remain supported", async () => {
  for (const name of ["start", "cancel", "decide"]) for (const response of [{id:"r1"},{id:"r1",status:"provider_waiting"}]) {
    const controller = createPiWorkController({ invoke: async () => response, getWorkspace: () => "C:/live", timers: fakeTimers() });
    seedAction(controller);
    assert.equal(await mutation(controller,name),true);
    assert.deepEqual(controller.state.runs,[response]);
    assert.equal(controller.state.selectedId,"r1");
    assert.equal(controller.state.error,null);
    assert.equal(piWorkStatusLabel(response.status),response.status ?? "不明");
    controller.dispose();
  }
});

test("cancel and decision reject a deferred response for a different valid run ID", async () => {
  for (const name of ["cancel", "decide"]) {
    const pending = deferred(), calls = [], timers = fakeTimers();
    const controller = createPiWorkController({ invoke: (command,args) => { calls.push([command,args]); return pending.promise; }, timers });
    seedAction(controller);
    const initial = structuredClone(controller.state.runs), changed = mutation(controller,name);
    assert.equal(controller.state.busy,true);
    await controller.load();
    pending.resolve(run({id:"other-valid-id",status:"done"}));
    assert.equal(await changed,false);
    assert.deepEqual(controller.state.runs,initial);
    assert.equal(controller.state.selectedId,"r1");
    assert.equal(controller.state.busy,false);
    assert.match(controller.state.error,/応答を確認できません/);
    assert.deepEqual(calls,name === "cancel" ? [["pi_work_cancel",{id:"r1"}]] : [["pi_work_decide",{runId:"r1",actionId:"a1",approve:false}]]);
    assert.equal(timers.active.size,0);
    controller.dispose();
  }
});
