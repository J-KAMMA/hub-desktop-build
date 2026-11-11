// Wallet network selection (2026-10-15, owner-approved).
//
// The native side owns the allowlist and the persisted choice. This module only
// renders it and asks the user: a network is never switched unless the user
// picks it in the wallet view or confirms a switch prompt. A request that names
// another network (tip, shop payment, x402, wallet link) is refused by Rust with
// `wallet_chain_switch_required:<chainId>`; `guardWalletChain` turns that into
// one explicit prompt and retries the same command only after the user agrees.

import { isPaidAiCommand } from "./ai-paid-execution.mjs";
import { filterInvoke } from "./yt-unplayable.mjs";

const MAINNET_WARNING = "本物のお金が動きます。送る前に、ネットワーク・宛先・数量を確かめてください。";
const TESTNET_NOTE = "テスト用のネットワークです。価値のないトークンで、本物のお金は動きません。";
const SWITCH_CODE = /^wallet_chain_switch_required:(\d{1,15})$/;

export const walletMainnetWarning = MAINNET_WARNING;

export function walletSwitchRequest(error) {
  const text = typeof error === "string" ? error : error instanceof Error && typeof error.message === "string" ? error.message : "";
  const match = SWITCH_CODE.exec(text);
  if (!match) return null;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null;
}

// Wraps an invoke function. Only the exact switch-required code is handled; any
// other error passes through untouched. After consent the call is retried once,
// so a second refusal (a different chain, or the user switched back) surfaces.
//
// Paid AI execution is off by default (ai-paid-execution.mjs): its commands are
// refused here before they reach Rust, so no switch prompt can be raised for an
// AI payment. Pass { paidAiExecution: true } to allow them again.
// 窓口の唯一の入口なので、埋め込みで再生できないと分かった YouTube の項目を一覧の応答から外す処理もここに通す（yt-unplayable.mjs）。
export function guardWalletChain(source, confirmSwitch, { paidAiExecution = false } = {}) {
  const rawInvoke = filterInvoke(source);
  return async (name, args) => {
    if (!paidAiExecution && isPaidAiCommand(name)) throw new Error("ai_paid_execution_disabled");
    try {
      return await rawInvoke(name, args);
    } catch (error) {
      const chainId = walletSwitchRequest(error);
      if (chainId === null) throw error;
      if (await confirmSwitch(chainId) !== true) throw new Error("wallet_user_rejected");
      return rawInvoke(name, args);
    }
  };
}

const element = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const validChain = (chain) => chain && Number.isSafeInteger(chain.chainId) && chain.chainId > 0
  && typeof chain.name === "string" && chain.name.length > 0 && chain.name.length <= 80
  && typeof chain.symbol === "string" && chain.symbol.length > 0 && chain.symbol.length <= 12;

export const chainLabel = (chain) => `${chain.name}（${chain.symbol}）${chain.mainnet ? "" : " ・テスト用"}`;

export function networkNotice(document, mainnet) {
  return element(document, "p", mainnet ? "wallet-mainnet-warning" : "wallet-testnet-note", mainnet ? MAINNET_WARNING : TESTNET_NOTE);
}

// Network picker for the wallet view: a select listing network name + native
// currency, the mainnet warning, and the developer setting that reveals testnets.
// The rail summary passes showWarning:false so the warning waits for the send flow.
export function createWalletNetwork({ document, invoke, status, isCurrent = () => true, onChanged = () => {}, describeError = String, showWarning = true, compact = false }) {
  const root = element(document, "section", compact ? "wallet-network-picker is-compact" : "wallet-network-picker");
  const chains = (Array.isArray(status?.chains) ? status.chains : []).filter(validChain);
  const label = element(document, "label", "wallet-network-label", "ネットワーク");
  const select = document.createElement("select");
  select.className = "wallet-network-select";
  select.setAttribute("aria-label", "ネットワーク");
  const known = new Set();
  for (const chain of chains) {
    const option = document.createElement("option");
    option.value = String(chain.chainId);
    option.textContent = chainLabel(chain);
    select.append(option);
    known.add(chain.chainId);
  }
  if (!known.has(status?.chainId) && Number.isSafeInteger(status?.chainId)) {
    const option = document.createElement("option");
    option.value = String(status.chainId);
    option.textContent = chainLabel({ name: status.chainName ?? `chain ${status.chainId}`, symbol: status.symbol ?? "—", mainnet: status.mainnet });
    select.append(option);
  }
  select.value = String(status?.chainId);
  label.append(select);
  const note = element(document, "p", "wallet-note", "");
  note.setAttribute("role", "status");
  const warning = showWarning ? networkNotice(document, status?.mainnet === true) : null;
  select.onchange = async () => {
    const chainId = Number(select.value);
    select.disabled = true;
    note.textContent = "ネットワークを切り替えています…";
    try {
      await invoke("wallet_select_chain", { chainId });
      if (isCurrent()) onChanged(chainId);
    } catch (error) {
      select.value = String(status.chainId);
      note.textContent = describeError(error);
    } finally {
      select.disabled = false;
    }
  };

  const developer = document.createElement("details");
  developer.className = "wallet-developer";
  developer.append(element(document, "summary", "", "開発者向け設定"));
  const toggleLabel = element(document, "label", "wallet-developer-toggle", "");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = status?.developer === true;
  toggleLabel.append(toggle, " テスト用ネットワークを選べるようにする");
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      await invoke("wallet_set_developer", { enabled: toggle.checked });
      if (isCurrent()) onChanged(null);
    } catch (error) {
      toggle.checked = !toggle.checked;
      note.textContent = describeError(error);
    } finally {
      toggle.disabled = false;
    }
  };
  developer.append(toggleLabel, element(document, "p", "wallet-note", "オフのときは本番ネットワークだけを表示します。テスト用ネットワークは開発者向けです。"));
  // Compact mode (right rail): the current network is a small pill; the existing chooser (the same select)
  // opens under it on demand. Nothing here switches a network by itself.
  let pill = null, chooser = null;
  if (compact) {
    const current = chains.find((chain) => chain.chainId === status?.chainId);
    const name = current?.name ?? status?.chainName ?? `chain ${status?.chainId}`;
    pill = element(document, "button", "wallet-network-pill");
    pill.type = "button";
    pill.setAttribute("aria-expanded", "false");
    pill.setAttribute("aria-label", `ネットワーク：${name}。押すと切り替えられます`);
    pill.append(element(document, "span", "wallet-chain-mark", [...name][0]?.toUpperCase() ?? "?"), element(document, "span", "wallet-network-pill-name", name), element(document, "span", "wallet-network-pill-caret", "▾"));
    chooser = element(document, "div", "wallet-network-chooser");
    chooser.hidden = true;
    chooser.append(label, note, developer);
    pill.onclick = () => {
      chooser.hidden = !chooser.hidden;
      pill.setAttribute("aria-expanded", String(!chooser.hidden));
      if (!chooser.hidden) {
        select.focus();
        // 札を押したら一覧までそのまま開く（札 → 選ぶ、の2手。以前は 札 → 欄 → 選ぶ の3手）。
        // 開くだけで、切り替えるのは利用者が一覧から選んだときだけ（select.onchange）。開けない環境では欄に焦点だけ移す。
        try { select.showPicker?.(); } catch { /* 焦点だけ */ }
      }
    };
    root.append(pill, chooser);
  } else {
    root.append(label, ...(warning ? [warning] : []), note, developer);
  }
  return { element: root, select, toggle, note, warning, pill, chooser, destroy() { select.onchange = null; toggle.onchange = null; if (pill) pill.onclick = null; } };
}

// "1234500000000000000" with 18 decimals -> "1.2345". Never rounds up.
export function formatUnits(raw, decimals) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const value = BigInt(raw), base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  const whole = value / base;
  if (value > 0n && whole === 0n && !fraction) return "0.000001未満";
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

// Known-token balances for the selected network (read-only; JPYC where listed).
// A token whose read failed shows "取得できません", and an answer for another
// network than the one on screen is dropped.
export function createWalletTokens({ document, invoke, status, isCurrent = () => true, showEmpty = false }) {
  const root = element(document, "section", "wallet-token-list");
  root.hidden = true;
  const tokens = Array.isArray(status?.tokens) ? status.tokens : [];
  if (!tokens.length) {
    if (showEmpty) {
      root.hidden = false;
      root.append(element(document, "strong", "wallet-token-heading", "トークン"), element(document, "p", "wallet-note wallet-token-empty", "トークンはまだありません"));
    }
    return { element: root, ready: Promise.resolve() };
  }
  root.hidden = false;
  root.append(element(document, "strong", "wallet-token-heading", `${status.chainName ?? "このネットワーク"} のトークン残高`));
  const rows = new Map();
  for (const token of tokens) {
    const row = element(document, "div", "wallet-list-row wallet-token-row");
    const value = element(document, "span", "wallet-note wallet-token-balance is-loading", "確認中…");
    const initial = element(document, "span", "wallet-token-avatar", [...String(token.symbol)][0]?.toUpperCase() ?? "?");
    initial.dataset.tint = String([...String(token.symbol)].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 4);
    initial.setAttribute("aria-hidden", "true");
    const name = element(document, "span", "wallet-token-name");
    name.append(element(document, "strong", "", token.symbol), element(document, "span", "wallet-note", status.chainName ?? ""));
    row.append(initial, name, value);
    root.append(row);
    rows.set(token.address.toLowerCase(), { value, decimals: token.decimals });
  }
  const ready = Promise.resolve(invoke("wallet_token_balances")).then((result) => {
    if (!isCurrent()) return;
    if (result?.chainId !== status.chainId || !Array.isArray(result.tokens)) throw new Error("chain_changed");
    for (const token of result.tokens) {
      const row = rows.get(String(token?.address).toLowerCase());
      if (!row) continue;
      const text = formatUnits(token.balanceRaw, row.decimals);
      row.value.textContent = text === null ? "取得できません" : text;
    }
    for (const row of rows.values()) { row.value.classList.remove("is-loading"); if ((globalThis.__hubI18n?.source(row.value) ?? row.value.textContent) === "確認中…") row.value.textContent = "取得できません"; }
  }).catch(() => {
    if (!isCurrent()) return;
    for (const row of rows.values()) row.value.textContent = "取得できません";
  });
  return { element: root, ready };
}

// The explicit switch prompt. Resolves true only after the user presses the
// switch button AND the native side accepted the new network. A network that is
// not selectable (a testnet while the developer setting is off) gets an
// explanation only; nothing is switched.
export function confirmNetworkSwitch({ document, invoke, requested, status, describeError = String, onSwitched = () => {} }) {
  const chains = Array.isArray(status?.chains) ? status.chains.filter(validChain) : [];
  const target = chains.find((chain) => chain.chainId === requested);
  const current = `${status?.chainName ?? "不明"}（chain ID ${status?.chainId}）`;
  const dialog = document.createElement("dialog");
  dialog.className = "wallet-network-dialog";
  dialog.setAttribute("aria-labelledby", "wallet-network-dialog-title");
  const shell = element(document, "div", "dialog-shell dialog-narrow");
  const title = element(document, "h2", "", "ネットワークの切り替えが必要です");
  title.id = "wallet-network-dialog-title";
  const body = element(document, "div", "wallet-network-dialog-body");
  const note = element(document, "p", "wallet-note", "");
  note.setAttribute("role", "status");
  const actions = element(document, "div", "actions");
  const cancel = element(document, "button", "deny", target ? "キャンセル" : "閉じる");
  cancel.type = "button";
  const approve = element(document, "button", "approve", "切り替える");
  approve.type = "button";
  if (target) {
    body.append(
      element(document, "p", "", `この操作は ${chainLabel(target)}（chain ID ${target.chainId}）で行われます。`),
      element(document, "p", "", `いまのウォレットは ${current} です。切り替えるまで、署名も送金も行いません。`),
      networkNotice(document, target.mainnet === true),
    );
    actions.append(cancel, approve);
  } else {
    body.append(
      element(document, "p", "", `この操作は chain ID ${requested} のネットワークで行われます。いまのウォレットは ${current} です。`),
      element(document, "p", "wallet-note", "このネットワークは選べません。テスト用ネットワークは、ウォレット画面の開発者向け設定をオンにすると選べます。署名も送金も行っていません。"),
    );
    actions.append(cancel);
  }
  shell.append(title, body, note, actions);
  dialog.append(shell);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (dialog.open) dialog.close(); } catch { /* already closed */ }
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
    cancel.onclick = () => finish(false);
    approve.onclick = async () => {
      approve.disabled = true;
      note.textContent = "切り替えています…";
      try {
        await invoke("wallet_select_chain", { chainId: requested });
        try { onSwitched(requested); } catch { /* the switch itself succeeded */ }
        finish(true);
      } catch (error) {
        note.textContent = describeError(error);
        approve.disabled = false;
      }
    };
    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    cancel.focus();
  });
}
