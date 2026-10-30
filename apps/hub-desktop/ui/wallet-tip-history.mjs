import { appendWalletHistoryLinks } from './wallet-history-links.mjs';

const chains = new Map([
  ['ethereum', 1], ['eth', 1], ['mainnet', 1], ['polygon', 137], ['matic', 137],
  ['polygon amoy', 80002], ['amoy', 80002], ['base', 8453], ['arbitrum one', 42161],
  ['arbitrum', 42161], ['op mainnet', 10], ['optimism', 10],
]);
const clean = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function entries(value, kind) {
  if (!Array.isArray(value) || value.length > (kind === 'tip' ? 100 : 50)) throw Error('invalid_history');
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !clean(item.id, 160) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(item.id)
      || !clean(item.network, 80) || !chains.has(item.network.toLowerCase()) || !clean(item.symbol, 16) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.symbol)
      || typeof item.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(item.txHash) || typeof item.amount !== 'string' || !/^(?:0|[1-9]\d{0,77})(?:\.\d{1,18})?$/.test(item.amount)
      || typeof item.confirmedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item.confirmedAt)
      || item.explorerUrl !== null && (!clean(item.explorerUrl, 2048))
      || kind === 'tip' && !['received', 'sent'].includes(item.direction) || kind === 'activity' && !['transfer', 'contract'].includes(item.type)) throw Error('invalid_history');
    const chainId = chains.get(item.network.toLowerCase()), timestamp = Date.parse(item.confirmedAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== (item.confirmedAt.includes('.') ? item.confirmedAt : item.confirmedAt.replace(/Z$/, '.000Z'))
      || item.chainId !== undefined && item.chainId !== chainId) throw Error('invalid_history');
    const [integer, fraction = ''] = item.amount.split('.'), wei = BigInt(integer) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
    if (wei > (1n << 256n) - 1n || kind === 'tip' && wei === 0n || ids.has(item.id)) throw Error('invalid_history');
    ids.add(item.id);
    return { id: item.id, chainId, txHash: item.txHash, explorerUrl: item.explorerUrl, amount: item.amount, symbol: item.symbol, network: item.network, confirmedAt: item.confirmedAt, timestamp,
      direction: kind === 'tip' ? item.direction : null, label: kind === 'tip' ? item.direction === 'received' ? '受取チップ' : '送信チップ' : item.type === 'transfer' ? '送受信' : 'コントラクト' };
  });
}

export function createWalletHistory(document, { activity = [], activityUnavailable = false, invoke, isCurrent = () => true, copy, open, compact = false }) {
  const element = document.createElement('section'); element.className = compact ? 'wallet-section wallet-history is-compact' : 'wallet-section'; element.setAttribute('aria-label', '確認済みの取引履歴');
  const heading = document.createElement('h3'); heading.textContent = '最近の履歴';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = compact ? 'btn btn-ghost wallet-history-refresh' : 'head-action'; refresh.textContent = '履歴を更新';
  const note = document.createElement('p'); note.className = 'wallet-note'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  const list = document.createElement('div');
  const head = document.createElement('div'); head.className = 'wallet-history-head';
  const state = document.createElement('div'); state.className = 'state-panel is-compact'; state.hidden = true;
  const stateBody = note; if (compact) stateBody.className = 'state-body';
  if (compact) { head.append(heading, refresh); element.append(head, state, list); } else element.append(heading, refresh, note, list);
  let activities = [], tips = [], pending = null, loaded = false, failed = false, destroyed = false, invalidated = false, generation = 0;
  try { activities = entries(activity, 'activity'); } catch { activityUnavailable = true; }
  function invalidate() {
    if (destroyed || invalidated) return;
    invalidated = true; generation++; activities = []; tips = []; list.replaceChildren(); note.textContent = '履歴を再読み込みしてください。'; refresh.disabled = true; element.setAttribute('aria-busy', 'false'); if (compact) { state.hidden = false; state.replaceChildren(note); }
  }
  function current(turn = generation) {
    if (destroyed || invalidated || turn !== generation) return false;
    if (!isCurrent()) { invalidate(); return false; }
    return true;
  }
  const merged0 = () => [...activities, ...tips];
  function render() {
    refresh.disabled = !!pending; refresh.textContent = failed ? 'チップ履歴を再試行' : '履歴を更新'; element.setAttribute('aria-busy', String(!!pending));
    const bothFailed = activityUnavailable && failed && !tips.length && !pending;
    const messages = bothFailed ? ['履歴を取得できませんでした。再試行してください。'] : [activityUnavailable && '送受信・コントラクト履歴を取得できませんでした。', pending && 'チップ履歴を取得中…', failed && (tips.length ? 'チップ履歴を更新できませんでした。前回取得した履歴を表示しています。' : 'チップ履歴を取得できませんでした。再試行してください。')].filter(Boolean);
    note.textContent = messages.join(' ');
    if (compact) {
      // 取得失敗・空は、控えめな state-panel に出し、再試行ボタンもそこへ移す。
      const empty = !messages.length && loaded && !pending && !failed && !merged0().length;
      const shown = messages.length > 0 || empty;
      state.hidden = !shown;
      if (!messages.length) stateBody.textContent = empty ? '確認済みの取引はまだありません。' : '';
      state.replaceChildren(stateBody);
      if (messages.length && !pending) { refresh.className = 'btn btn-secondary state-action'; state.append(refresh); } else { refresh.className = 'btn btn-ghost wallet-history-refresh'; head.append(refresh); }
    }
    list.replaceChildren();
    const merged = [...activities, ...tips].sort((left, right) => right.timestamp - left.timestamp);
    for (const item of merged) {
      const row = document.createElement('div'); row.className = compact ? 'wallet-list-row wallet-history-row' : 'wallet-list-row'; row.dataset.historyId = item.id;
      const summary = document.createElement('strong'); summary.textContent = `${item.label} ${item.amount} ${item.symbol}`;
      const metadata = document.createElement('span'); metadata.className = 'wallet-note'; metadata.textContent = `${item.network} · ${new Date(item.timestamp).toLocaleString('ja-JP')}`;
      if (compact) {
        const icon = document.createElement('span'); icon.className = 'wallet-history-icon'; icon.setAttribute('aria-hidden', 'true');
        icon.textContent = item.direction === 'received' ? '↓' : item.direction === 'sent' ? '↑' : item.label === 'コントラクト' ? '◇' : '⇄';
        const main = document.createElement('span'); main.className = 'wallet-history-main';
        const title = document.createElement('strong'); title.textContent = item.label;
        const sub = document.createElement('span'); sub.className = 'wallet-note'; sub.textContent = `${item.txHash.slice(0, 6)}…${item.txHash.slice(-4)} · ${new Date(item.timestamp).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
        main.append(title, sub);
        const amount = document.createElement('span'); amount.className = 'wallet-history-amount'; amount.textContent = `${item.direction === 'received' ? '+' : item.direction === 'sent' ? '−' : ''}${item.amount} ${item.symbol}`;
        row.append(icon, main, amount);
      } else row.append(summary, metadata);
      appendWalletHistoryLinks(document, row, item, { copy, open, isCurrent: () => current() && row.isConnected });
      list.append(row);
    }
    if (!compact && !merged.length && loaded && !pending && !failed && !activityUnavailable) { const empty = document.createElement('p'); empty.className = 'wallet-note'; empty.textContent = '確認済みの取引はまだありません。'; list.append(empty); }
  }
  function reload() {
    if (!current()) return Promise.resolve();
    if (pending) return pending;
    const turn = ++generation;
    pending = Promise.resolve().then(() => current(turn) ? invoke('hub_client', { name: 'tips' }) : undefined).then(result => {
      if (!current(turn)) return;
      tips = entries(result?.tips, 'tip'); loaded = true; failed = false;
    }).catch(() => { if (current(turn)) failed = true; }).finally(() => {
      if (!current(turn)) return;
      pending = null; render();
    });
    render(); return pending;
  }
  refresh.onclick = () => reload();
  document.defaultView?.addEventListener('hub-account-changed', invalidate);
  const ready = reload();
  return { element, ready, reload, destroy() { if (destroyed) return; destroyed = true; generation++; activities = []; tips = []; list.replaceChildren(); document.defaultView?.removeEventListener('hub-account-changed', invalidate); element.remove(); } };
}
