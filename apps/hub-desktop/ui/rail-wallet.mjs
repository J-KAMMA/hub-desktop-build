// 右列の「ウォレット」（2026-10-15 所有者指定：ウォレットは左列から右列へ）。
//
// ネットワーク・残高（JPYC などのトークン含む）・受取・送金・最近の履歴を右列だけで済ませる
// （2026-10-25 所有者「ウォレットを開くじゃなくて右だけで完結してほしい」）。
// 送金は中央と同じ wallet_send_native を呼ぶ。端末側の確認画面（wallet-confirm-dialog）を必ず通るので、
// 確認を省く経路は増えない。本番ネットワークの警告は送金欄を開いたときだけ見せる。
// ネットワーク選択・トークン残高・履歴は、中央のウォレット画面と同じ部品を使う。
// 交換・スワップ・ブリッジ・価格比較は置かない（AGENTS.md のウォレット規約）。鍵は端末の外へ出ない。

import { createWalletNetwork, createWalletTokens, formatUnits, networkNotice } from "./wallet-network.mjs";
import { createWalletHistory } from "./wallet-tip-history.mjs";

const HISTORY_ROWS = 5;
const MAX_BALANCE = (1n << 128n) - 1n;

const text = (document, tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
};

const button = (document, className, label, onClick) => {
  const node = text(document, "button", className, label);
  node.type = "button";
  node.onclick = onClick;
  return node;
};

// 残高の文字列（wei）を表示用に直す。不正な値は null（呼び側が「確認できません」にする）。
export function railBalanceSummary(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const wei = BigInt(value);
  if (wei > MAX_BALANCE) return null;
  const label = formatUnits(value, 18);
  return label === null ? null : { label, canSend: wei > 0n };
}

// 数量の入力をweiへ。小数18桁まで。BigIntで組むので精度は落ちない（app.js の tokenToWei と同じ規則）。
export function amountToWei(value) {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return BigInt(match[1]) * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0"));
}

export const shortAddress =(value) => (typeof value === "string" && value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : String(value));
// 0x を除いた40桁を、4文字ずつの10組にする。
export const addressGroups = (value) => (/^0x[0-9a-fA-F]{40}$/.test(value) ? value.slice(2).match(/.{4}/g) : [String(value)]);

const TAB_KEY = "hub.rail.wallet.tab";
const defaultStorage = (document) => { try { return document.defaultView?.localStorage ?? null; } catch { return null; } };
const readTab = (storage) => { try { return storage?.getItem(TAB_KEY) === "history" ? "history" : "tokens"; } catch { return "tokens"; } };
const writeTab = (storage, key) => { try { storage?.setItem(TAB_KEY, key); } catch { /* 覚えられなくても表示は続ける */ } };

export function createRailWallet({
  document, invoke, isCurrent = () => true, describeError = String, settle = (promise) => promise,
  copy = (value) => navigator.clipboard.writeText(value), storage = defaultStorage(document), openWallet = () => {}, onChanged = () => {}, open = () => {},
}) {
  const element = document.createElement("div");
  element.className = "rail-wallet-body";
  const loading = text(document, "p", "wallet-note", "ウォレットを確認しています…");
  loading.setAttribute("role", "status");
  element.append(loading);
  let history = null;
  let destroyed = false;
  let copyTimer = null;
  const live = () => !destroyed && isCurrent();

  const openRow = () => button(document, "btn btn-ghost rail-wallet-open", "ウォレットを開く", () => openWallet({}));

  async function render() {
    const [statusResult, hubResult] = await Promise.allSettled([settle(invoke("wallet_status")), settle(invoke("hub_client", { name: "wallet" }))]);
    if (!live()) return;
    const status = statusResult.status === "fulfilled" ? statusResult.value : null;
    if (!status?.address) {
      element.replaceChildren(
        text(document, "h3", "", "この端末のウォレットを開けません"),
        text(document, "p", "wallet-note", statusResult.status === "rejected" ? describeError(statusResult.reason) : "アドレスを取得できませんでした。更新して再試行してください。"),
        openRow(),
      );
      return;
    }
    const hub = hubResult.status === "fulfilled" ? hubResult.value : null;
    const activity = Array.isArray(hub?.activity) ? hub.activity.slice(0, HISTORY_ROWS) : [];
    const networkName = status.chainName || `chain ${status.chainId}`;
    const symbol = typeof status.symbol === "string" && status.symbol ? status.symbol : "ネイティブトークン";

    // 警告は右列には出さない。送金の確認画面（中央の送金フロー）でだけ見せる。
    const network = createWalletNetwork({ document, invoke, status, isCurrent: live, describeError, onChanged: () => { onChanged(); }, showWarning: false, compact: true });
    const account = text(document, "span", "rail-wallet-account", shortAddress(status.address));
    account.title = status.address;
    const head = document.createElement("div");
    head.className = "rail-wallet-head";
    head.append(network.pill, account);

    const balance = text(document, "strong", "wallet-balance", "—");
    const unit = text(document, "span", "wallet-unit", symbol);
    const balanceRow = document.createElement("div");
    balanceRow.className = "wallet-balance-row";
    balanceRow.append(balance, unit);
    const balanceState = text(document, "p", "wallet-balance-state", "残高を確認中…");
    balanceState.id = "rail-wallet-balance-state";
    balanceState.setAttribute("role", "status");
    const tokens = createWalletTokens({ document, invoke, status, isCurrent: live, showEmpty: true });

    const note = text(document, "p", "wallet-note", "");
    note.setAttribute("role", "status");

    // コピー：シートのボタンと丸いボタンで共有。短い「コピーしました」を一瞬だけ見せる。
    const copyLabels = [];
    const copyAddress = async () => {
      try {
        await copy(status.address);
        for (const entry of copyLabels) { entry.node.textContent = "コピーしました"; entry.owner.classList.add("is-done"); }
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { for (const entry of copyLabels) { entry.node.textContent = entry.idle; entry.owner.classList.remove("is-done"); } }, 1600);
      } catch { note.textContent = "コピーできませんでした。"; }
    };

    // 受け取る：アドレスを4文字ずつに区切って見せる。QRコードを作る部品はこのリポジトリに無いので出さない。
    const sheet = document.createElement("section");
    sheet.className = "rail-wallet-sheet";
    sheet.setAttribute("aria-label", "受取アドレス");
    sheet.hidden = true;
    const address = document.createElement("p");
    address.className = "wallet-address mono";
    address.title = status.address;
    address.dataset.address = status.address;
    address.append(text(document, "span", "wallet-address-prefix", "0x"));
    for (const group of addressGroups(status.address)) { address.append(" ", text(document, "span", "wallet-address-group", group)); }
    const copyButton = button(document, "btn btn-secondary rail-wallet-copy", "アドレスをコピー", copyAddress);
    copyLabels.push({ node: copyButton, owner: copyButton, idle: "アドレスをコピー" });
    sheet.append(
      text(document, "strong", "rail-wallet-label", "受取アドレス"), address,
      text(document, "p", "wallet-note", `受け取るときは ${networkName} のアドレスとして共有してください。別のネットワークで送ると受け取れないことがあります。`),
      copyButton,
    );

    // 送る：宛先と数量を入れ、端末の確認画面を通して送る。中身は開いたときに作る（警告を先に出さない）。
    let available = 0n;
    const sendSheet = document.createElement("section");
    sendSheet.className = "rail-wallet-sheet rail-wallet-send-sheet";
    sendSheet.setAttribute("aria-label", "送金");
    sendSheet.hidden = true;
    const fillSendSheet = () => {
      if (sendSheet.childElementCount) return;
      const field = (label, input) => { const node = text(document, "label", "rail-wallet-field", label); node.append(input); return node; };
      const toInput = document.createElement("input");
      toInput.type = "text";
      toInput.className = "rail-wallet-input mono";
      toInput.placeholder = "0x…";
      toInput.maxLength = 42;
      toInput.spellcheck = false;
      toInput.autocomplete = "off";
      const amountInput = document.createElement("input");
      amountInput.type = "text";
      amountInput.className = "rail-wallet-input";
      amountInput.inputMode = "decimal";
      amountInput.maxLength = 30;
      amountInput.placeholder = "0";
      const sendNote = text(document, "p", "wallet-note rail-wallet-send-note", "");
      sendNote.setAttribute("role", "status");
      const submit = button(document, "btn btn-primary rail-wallet-submit", "内容を確認して送金", async () => {
        const to = toInput.value.trim();
        const wei = amountToWei(amountInput.value);
        if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { sendNote.textContent = "送り先のアドレスが正しくありません。"; toInput.focus(); return; }
        if (to.toLowerCase() === status.address.toLowerCase()) { sendNote.textContent = "自分のアドレスへは送れません。"; return; }
        if (!wei || wei <= 0n) { sendNote.textContent = "数量が正しくありません。"; amountInput.focus(); return; }
        if (wei > available) { sendNote.textContent = "残高を超えています。手数料の分も残してください。"; return; }
        submit.disabled = true;
        sendNote.textContent = "確認画面で宛先と数量を確かめてください。";
        try {
          const hash = await invoke("wallet_send_native", { chainId: status.chainId, to, amountWei: wei.toString() });
          if (!live()) return;
          sendNote.textContent = `送金をネットワークへ届けました。${shortAddress(String(hash))}`;
          toInput.value = amountInput.value = "";
        } catch (error) {
          if (live()) sendNote.textContent = describeError(error);
        } finally {
          submit.disabled = false;
        }
      });
      sendSheet.append(
        text(document, "strong", "rail-wallet-label", `${symbol} を送る`),
        networkNotice(document, status.mainnet === true),
        field("送り先アドレス", toInput), field(`数量（${symbol}）`, amountInput),
        submit, sendNote,
      );
    };

    // 丸いボタン（アイコン＋短いラベル）。受け取る・送るは下に欄を開く。同時に開くのは片方だけ。
    const action = (className, label, glyph, onClick) => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = `rail-wallet-action ${className}`;
      node.onclick = onClick;
      const icon = text(document, "span", "rail-wallet-action-icon", "");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
      const caption = text(document, "span", "rail-wallet-action-label", label);
      node.append(icon, caption);
      return { node, caption };
    };
    const toggle = (panel, owner) => {
      const opening = panel.hidden;
      sheet.hidden = sendSheet.hidden = true;
      receive.setAttribute("aria-expanded", "false");
      send.setAttribute("aria-expanded", "false");
      panel.hidden = !opening;
      owner.setAttribute("aria-expanded", String(opening));
      if (opening) panel.querySelector("input")?.focus();
    };
    const receiveAction = action("rail-wallet-receive", "受け取る", '<path d="M12 5v14m-6-6 6 6 6-6"/>', () => toggle(sheet, receive));
    const receive = receiveAction.node;
    receive.setAttribute("aria-expanded", "false");
    const sendAction = action("rail-wallet-send", "送る", '<path d="M12 19V5m-6 6 6-6 6 6"/>', () => { fillSendSheet(); toggle(sendSheet, send); });
    const send = sendAction.node;
    send.setAttribute("aria-expanded", "false");
    send.disabled = true;
    send.title = "残高を確認しています";
    send.setAttribute("aria-describedby", balanceState.id);
    const copyAction = action("rail-wallet-action-copy", "コピー", '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/>', copyAddress);
    copyAction.node.title = "アドレスをコピー";
    copyLabels.push({ node: copyAction.caption, owner: copyAction.node, idle: "コピー" });
    const actions = document.createElement("div");
    actions.className = "wallet-actions";
    actions.append(receive, send, copyAction.node);

    history?.destroy();
    history = createWalletHistory(document, {
      activity, activityUnavailable: hubResult.status === "rejected", invoke, isCurrent: live,
      copy: (value) => navigator.clipboard.writeText(value), open, compact: true,
    });

    const hero = document.createElement("section");
    hero.className = "rail-wallet-hero";
    hero.append(head, network.chooser, balanceRow, balanceState, actions, sheet, sendSheet);

    // 分割タブ：トークン／履歴。選んだ側はこの端末に覚えておく。
    const tabDefs = [["tokens", "トークン", tokens.element], ["history", "履歴", history.element]];
    const tabs = document.createElement("div");
    tabs.className = "rail-wallet-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "ウォレットの表示");
    const panels = document.createElement("div");
    panels.className = "rail-wallet-panels";
    const tabNodes = new Map();
    const select = (key, { focus = false, remember = true } = {}) => {
      if (remember) writeTab(storage, key);
      for (const [id, , panel] of tabDefs) {
        const on = id === key;
        const tab = tabNodes.get(id);
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        tab.classList.toggle("is-selected", on);
        panel.hidden = !on;
        if (on) { panel.classList.remove("is-entering"); void panel.offsetWidth; panel.classList.add("is-entering"); }
      }
      if (focus) tabNodes.get(key).focus();
    };
    tabDefs.forEach(([id, label, panel], index) => {
      const tab = button(document, "rail-wallet-tab", label, () => select(id));
      tab.id = `rail-wallet-tab-${id}`;
      tab.setAttribute("role", "tab");
      tab.onkeydown = (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step) { event.preventDefault(); select(tabDefs[(index + step + tabDefs.length) % tabDefs.length][0], { focus: true }); }
      };
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      panel.classList.add("rail-wallet-panel");
      tabNodes.set(id, tab);
      tabs.append(tab);
      panels.append(panel);
    });
    select(readTab(storage), { remember: false });

    element.replaceChildren(hero, note, tabs, panels);

    settle(invoke("wallet_balance")).then((result) => {
      if (!live()) return;
      // 別のネットワークの残高を、表示中のネットワークのものとして見せない。
      if (result?.chainId !== status.chainId) throw new RangeError("wallet balance is for another network");
      const summary = railBalanceSummary(result?.balanceWei);
      if (!summary) throw new RangeError("invalid wallet balance");
      balance.textContent = summary.label;
      balanceState.hidden = summary.canSend;
      available = BigInt(result.balanceWei);
      if (summary.canSend) { send.disabled = false; send.title = "宛先と数量を入れ、確認画面を通して送金します"; }
      else { balanceState.textContent = "まだ残高がありません"; send.title = "残高がないため送れません。先に受け取るでアドレスを共有できます"; }
    }).catch(() => {
      if (!live()) return;
      balanceState.classList.add("is-error");
      balance.textContent = "残高を確認できません";
      balance.classList.add("is-unavailable");
      unit.hidden = true;
      send.title = "残高を確認できないため送れません";
      balanceState.textContent = "送金は使えません。ネットワーク接続を確認してください。";
    });
  }

  const ready = render().catch(() => {
    if (!live()) return;
    element.replaceChildren(text(document, "p", "wallet-note", "ウォレットを表示できません。更新して再試行してください。"), openRow());
  });
  return { element, ready, destroy() { destroyed = true; clearTimeout(copyTimer); history?.destroy(); history = null; element.replaceChildren(); } };
}
