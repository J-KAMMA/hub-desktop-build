// Pi Work: the pi sidecar owns the agent loop, Hub owns tool execution and
// permissions. The window polls `pi_work_list` and renders a run list plus
// the selected run; approvals go through `pi_work_decide` when the backend
// provides it.
import { resolvePurchaseHandoff } from "./ai-purchase-handoff.mjs";
import { connectionModelRef } from "./pi-work-connection.mjs";

const terminal = new Set(["done", "failed", "cancelled"]);
export function piWorkIsTerminal(status) {
  return terminal.has(status);
}

const STATUS_LABELS = { running: "実行中", done: "返答終了", failed: "失敗", cancelled: "中断" };
export function piWorkStatusLabel(status, verification) {
  if (status === "done" && verification?.status === "passed") return "指定検証に合格";
  return STATUS_LABELS[status] ?? status ?? "不明";
}

export function hubWorkHistoryEntries(hubRuns, cliRuns) {
  return [
    ...(Array.isArray(hubRuns) ? hubRuns : []).map((run) => ({ kind: "hub", run })),
    ...(Array.isArray(cliRuns) ? cliRuns : []).map((run) => ({ kind: "cli", run }))
  ].sort((a, b) => (Number(b.run.startedAtMs) || 0) - (Number(a.run.startedAtMs) || 0));
}

/// One tool_call frame as a short line: name plus its settlement state.
/// `ok` stays absent until Hub answers, which reads as "実行中" rather than
/// a misleading null.
export function piWorkEventText(call) {
  const result = call?.ok === true ? "成功" : call?.ok === false ? "失敗" : "実行中";
  return `${call?.name ?? "tool"} · ${result}`;
}

/// `pendingActions` does not exist on the first shipped backend; an absent
/// field must render the same as an empty list, not crash the section.
export function pendingActionsOf(view) {
  return Array.isArray(view?.pendingActions) ? view.pendingActions : [];
}

export function missingFilePreview(action) {
  return ["hub_write", "hub_edit"].includes(action?.tool)
    && !["path", "before", "after"].every(key => typeof action.detail?.[key] === "string");
}

export function toolCallsOf(view) {
  return Array.isArray(view?.toolCalls) ? view.toolCalls : [];
}

/// An invoke rejection naming the command itself means this backend predates
/// `pi_work_decide`. Domain errors (`pi_work_not_found`, `pi_action_not_found`)
/// use underscores, so they can never satisfy these patterns.
export function isMissingCommandError(error) {
  return /unknown command|not a registered command|command\s+\S+\s+not found|not implemented/i.test(String(error));
}

const ERROR_TEXT = {
  workspace_not_found: "作業フォルダが見つかりません。共有の作業フォルダ設定を確認してください。",
  prompt_empty: "依頼内容を入力してください",
  prompt_too_long: "依頼内容は8000文字以内にしてください",
  standard_engine_retired: "この作業は旧方式のため再開できません。新しい作業として始めてください。",
  legacy_engine_requires_resume: "新しい作業は Pi の道具の方式で始めます。旧会話の方式は、その会話を再開するときだけ使えます。",
  verification_requires_exec: "検証コマンドを使うにはコマンド実行を有効にしてください。",
  required_verification_not_passed: "指定した検証コマンドが合格していません。実行記録を確認してください。",
  sidecar_script_missing: "Hubの作業エンジンが見つかりません。アプリの同梱ファイルを確認してください。",
  native_window_required: "この操作はデスクトップアプリの画面からだけ実行できます。",
  pi_work_not_found: "実行が見つかりません。すでに終了した可能性があります。",
  pi_session_unavailable: "再開に必要な会話の保存データが見つかりません。新しい作業として始めてください。",
  pi_session_workspace_mismatch: "元の実行と作業フォルダが異なります。元の作業フォルダを選んでください。",
  pi_session_engine_mismatch: "この接続では保存された会話を再開できません。新しい作業として始めてください。",
  pi_session_invalid: "保存された会話を読み込めません。新しい作業として始めてください。",
  purchase_execution_unavailable: "この画面ではAIの購入提案を実行できません。購入はマーケットで内容を確認してください。この提案は拒否できます。",
  purchase_proposal_invalid: "購入提案の内容が正しくないため、拒否しました。購入画面は開いていません。",
  purchase_handoff_failed: "商品を開けなかったため、この提案を拒否しました。購入は行われていません。",
  purchase_outcome_invalid: "購入画面を開いた記録を受け付けられませんでした。購入は行われていません。",
  purchase_outcome_missing: "購入の実行結果が届いていません。購入済みとして扱えません。マーケットで注文を確認してください。",
  pi_action_not_found: "承認待ちの操作が見つかりません。すでに処理された可能性があります。",
  byok_key_missing: "このAIの接続にはAPIキーが保存されていません。設定 → AIの接続でキーを保存してください。作業は始めていません。",
  byok_key_invalid: "保存されたAPIキーの形式が正しくありません。設定 → AIの接続でキーを保存し直してください。作業は始めていません。",
  byok_store_unavailable: "このPCの資格情報ストアを読めませんでした。作業は始めていません。",
  byok_store_unreadable: "AIの接続の設定ファイルを読めませんでした。作業は始めていません。",
  byok_connection_not_found: "選んだAIの接続が見つかりません。設定 → AIの接続を確認してください。",
  byok_disabled: "選んだAIの接続は無効になっています。設定 → AIの接続で有効にしてください。",
  byok_model_missing: "この接続には既定のモデルがありません。モデル名を入力してください。",
  byok_endpoint_not_allowed: "この接続の送信先は使えません（httpはこのPC内のサーバーだけです）。",
  byok_remote_not_allowed: "AIの接続を使う作業は、このPCのデスクトップ画面からだけ始められます。",
  byok_invalid_request: "AIの接続またはモデル名が正しくありません。",
  best_of_requires_verification: "複数回の試行には完了の検証コマンドが必要です。",
  best_of_estimate_unconfirmed: "試行回数の見積りが確認できません。見積りを確認してから開始してください。",
  best_of_attempts_invalid: "試行回数は2回か3回です。",
  best_of_unsupported: "複数回の試行は、新しい作業でだけ使えます。",
  best_of_workspace_too_large: "作業フォルダが大きすぎて、試行用の複製を作れません。",
  best_of_none_passed: "どの試行も検証に合格しませんでした。作業フォルダは変更していません。変更の最も小さい試行の差分を確認できます。",
  best_of_workspace_changed: "試行中に作業フォルダのファイルが変わったため、結果を反映しませんでした。"
};
export function piWorkErrorText(error) {
  const message = String(error ?? "");
  if (Object.hasOwn(ERROR_TEXT, message)) return ERROR_TEXT[message];
  if (message.includes("run already in progress")) return "この作業フォルダでは別の実行が進行中です。終了してから開始してください。";
  return message;
}

export const PI_WORK_MAX_PROMPT_CHARS = 8000;
/// Same default as `pi_best_of.rs` (`DEFAULT_TOKEN_CAP`); Rust refuses a start
/// whose `estimateTokens` differs from its own figure.
export const PI_BEST_OF_TOKEN_CAP = 500000;

/// The N-attempt estimate shown before a best-of start, or null for one attempt.
export function bestOfEstimate(value) {
  const attempts = Number(value);
  if (!value || !Number.isInteger(attempts) || attempts < 2 || attempts > 3) return null;
  const maxTokens = attempts * PI_BEST_OF_TOKEN_CAP;
  return { attempts, tokenCapPerAttempt: PI_BEST_OF_TOKEN_CAP, maxTokens,
    text: `${attempts}回試行：最大 ${maxTokens.toLocaleString("ja-JP")} トークン（1回あたり上限 ${PI_BEST_OF_TOKEN_CAP.toLocaleString("ja-JP")}、超えた試行は中断）。検証に合格した試行のうち変更の最も小さいものだけを、承認を経て作業フォルダに反映します。` };
}

/// Builds the `pi_work_start` arguments. `script` is deliberately absent:
/// the backend resolves the vendored sidecar path itself, and letting the
/// window name it would only widen what a crafted form could point at.
export function buildPiWorkRequest(form) {
  const workspace = String(form?.workspace ?? "").trim();
  if (!workspace) throw new Error("作業フォルダを設定してください");
  const prompt = String(form?.prompt ?? "").trim();
  if (!prompt) throw new Error("依頼内容を入力してください");
  if ([...prompt].length > PI_WORK_MAX_PROMPT_CHARS) throw new Error("依頼内容は8000文字以内にしてください");
  // A chosen "AIの接続" replaces the model field; Rust resolves it and reads the key.
  const model = connectionModelRef(form?.connection, form?.connectionModel) ?? String(form?.model ?? "").trim();
  const request = {
    workspace,
    prompt,
    allowWrite: Boolean(form?.allowWrite),
    allowExec: Boolean(form?.allowExec),
    allowHttp: Boolean(form?.allowHttp)
  };
  // An empty model is omitted so the backend-selected default
  // applies; sending "" would only be overwritten anyway.
  if (model) request.model = model;
  const program = String(form?.verifyProgram ?? "").trim();
  const args = String(form?.verifyArgs ?? "").split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean);
  if (args.length && !program) throw new Error("検証コマンドのプログラムを入力してください");
  if (program && !request.allowExec) throw new Error("検証コマンドを使うにはコマンド実行を有効にしてください");
  if (program) request.verification = { program, args };
  const checkers = Array.isArray(form?.checkers) ? form.checkers : [];
  if (checkers.length) {
    if (!request.allowExec) throw new Error("型・Lint検査を使うにはコマンド実行を有効にしてください");
    request.checkers = checkers.map(({ program: name, args: list = [], cwd = "" }) => ({ program: String(name), args: list.map(String), ...(cwd ? { cwd: String(cwd) } : {}) }));
  }
  const estimate = bestOfEstimate(form?.bestOf);
  if (estimate) {
    if (!program) throw new Error("複数回の試行には完了の検証コマンドが必要です");
    if (form?.resumeRunId) throw new Error("複数回の試行は新しい作業でだけ使えます");
    if (form?.bestOfConfirmed !== true) throw new Error("試行回数の見積りを確認してください");
    request.bestOf = { attempts: estimate.attempts, tokenCap: estimate.tokenCapPerAttempt, estimateTokens: estimate.maxTokens };
  }
  if (form?.resumeRunId) {
    request.resumeRunId = String(form.resumeRunId);
    // The standard engine was deleted (2026-10-18): only a dsh resume keeps its engine; everything else is thin. "pi" is never sent.
    request.engine = form.engine === "dsh" ? "dsh" : "thin";
  } else {
    request.engine = "thin";
  }
  return request;
}

export function createPiWorkController({ invoke, purchaseHandoff = null, render = () => {}, getWorkspace = () => "", pollIntervalMs = 1500, idlePollIntervalMs = 5000, shouldPoll = () => true, timers = globalThis }) {
  const state = { runs: [], selectedId: null, busy: false, error: null, decideSupported: true };
  let generation = 0;
  let readGeneration = 0;
  let disposed = false;
  let timer = null;
  let timerMs = 0;
  let pollInFlight = false;
  const actionKeys = new Set();

  const selected = () => state.runs.find((run) => run.id === state.selectedId) ?? null;
  const redraw = () => { if (!disposed) render({ ...state, selected: selected() }); };
  const current = token => !disposed && token === generation;
  const currentRead = (token, read) => current(token) && !state.busy && read === readGeneration;
  const fail = (error) => { state.error = String(error); redraw(); return null; };

  // The single poll loop. It runs at the fast cadence while a run can still
  // change, then drops to a slow discovery cadence instead of dying — a run
  // started outside this window (HTTP route, another tool, a restored lease)
  // must surface here, pending approvals included.
  const syncTimer = () => {
    if (disposed) return;
    const active = state.runs.some((run) => !terminal.has(run.status));
    const wanted = active ? pollIntervalMs : idlePollIntervalMs;
    if (timer !== null && timerMs !== wanted) {
      timers.clearInterval(timer);
      timer = null;
    }
    if (timer === null) {
      timerMs = wanted;
      timer = timers.setInterval(() => {
        if (disposed || state.busy || pollInFlight) return;
        // Each list call makes the backend inspect every kept run; nobody is looking, so skip the tick.
        if (!shouldPoll()) return;
        pollInFlight = true;
        void poll().finally(() => { pollInFlight = false; });
      }, wanted);
      // Node returns a Timeout; browsers a number. Unref so a lingering
      // interval can never hold a process (or test run) open.
      timer?.unref?.();
    }
  };

  function upsert(run, expectedId) {
    if (!run || typeof run !== "object" || Array.isArray(run) || typeof run.id !== "string" || !run.id || (expectedId !== undefined && run.id !== expectedId)) throw new Error("実行の応答を確認できません。状態を更新してください。");
    const index = state.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) state.runs[index] = run;
    else state.runs.push(run);
  }

  function keepSelection() {
    if (state.runs.some((run) => run.id === state.selectedId)) return;
    const ordered = [...state.runs].sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
    state.selectedId = (ordered.find((run) => !terminal.has(run.status)) ?? ordered[0])?.id ?? null;
  }

  async function load() {
    if (disposed || state.busy) return state;
    const token = generation, read = ++readGeneration;
    try {
      const runs = await invoke("pi_work_list", {});
      if (!currentRead(token, read)) return state;
      state.runs = Array.isArray(runs) ? runs : [];
      state.error = null;
      keepSelection();
      redraw();
      syncTimer();
    } catch (error) { if (currentRead(token, read)) fail(error); }
    return state;
  }

  async function start(form) {
    if (disposed || state.busy) return false;
    let request;
    try {
      // The workspace is read live at submit time; the controller never keeps
      // its own copy that could disagree with the shared input.
      request = buildPiWorkRequest({ ...form, workspace: getWorkspace() });
    } catch (error) { if (!disposed) { state.error = String(error?.message ?? error); redraw(); } return false; }
    if (disposed) return false;
    const token = ++generation;
    state.busy = true; state.error = null; redraw();
    if (!current(token)) return false;
    try {
      const run = await invoke("pi_work_start", request);
      if (!current(token)) return false;
      upsert(run);
      state.selectedId = run.id;
      state.busy = false;
      redraw();
      syncTimer();
      return true;
    } catch (error) { if (current(token)) { state.busy = false; fail(error); } return false; }
  }

  function select(id) {
    if (disposed || state.selectedId === id) return state;
    state.selectedId = id;
    redraw();
    return state;
  }

  async function cancel(id) {
    const run = state.runs.find((item) => item.id === id);
    if (disposed || state.busy || !run || terminal.has(run.status)) return false;
    const key = `${id}:cancel`;
    if (actionKeys.has(key)) return false;
    actionKeys.add(key); const token = ++generation; state.busy = true; redraw();
    if (!current(token)) return false;
    try {
      const updated = await invoke("pi_work_cancel", { id });
      if (!current(token)) return false;
      upsert(updated, id);
    } catch (error) { if (current(token)) { actionKeys.delete(key); state.busy = false; fail(error); } return false; }
    state.busy = false; redraw(); syncTimer(); return true;
  }

  async function decide(runId, actionId, approve) {
    if (disposed || !state.decideSupported || state.busy) return false;
    const run = state.runs.find((item) => item.id === runId);
    if (!run || terminal.has(run.status)) return false;
    const action = pendingActionsOf(run).find((action) => action.id === actionId);
    if (!action || (approve && missingFilePreview(action))) return false;
    if (approve && action.tool === "hub_pay" && typeof purchaseHandoff !== "function") { fail("purchase_execution_unavailable"); return false; }
    const key = `${runId}:${actionId}`;
    if (actionKeys.has(key)) return false;
    actionKeys.add(key); const token = ++generation; state.busy = true; redraw();
    if (!current(token)) return false;
    try {
      // Approving hub_pay opens the buyer's checkout screen and reports only
      // that handoff; a failed or invalid handoff resolves as a denial.
      const handoff = approve && action.tool === "hub_pay" ? await resolvePurchaseHandoff(action, purchaseHandoff) : null;
      if (!current(token)) return false;
      const updated = await invoke("pi_work_decide", handoff?.outcome
        ? { runId, actionId, approve: true, outcome: handoff.outcome }
        : { runId, actionId, approve: handoff ? false : Boolean(approve) });
      if (!current(token)) return false;
      upsert(updated, runId);
      if (handoff?.error) { state.busy = false; fail(handoff.error); return false; }
    }
    catch (error) {
      if (!current(token)) return false;
      actionKeys.delete(key);
      // A backend without pi_work_decide reports the command as missing; the
      // pending section stays hidden from then on rather than re-offering a
      // button that can never work.
      if (isMissingCommandError(error)) state.decideSupported = false;
      state.busy = false;
      fail(error);
      return false;
    }
    state.busy = false; redraw(); syncTimer(); return true;
  }

  async function poll() {
    if (disposed || state.busy) return false;
    const token = generation, read = ++readGeneration;
    try {
      const runs = await invoke("pi_work_list", {});
      if (!currentRead(token, read)) return false;
      state.runs = Array.isArray(runs) ? runs : state.runs;
      state.error = null;
      keepSelection();
      redraw();
      syncTimer();
      return state.runs.some((run) => !terminal.has(run.status));
    } catch (error) { if (currentRead(token, read)) fail(error); return false; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
    generation++;
  }

  return { state, load, start, select, cancel, decide, poll, dispose, refresh: redraw };
}
