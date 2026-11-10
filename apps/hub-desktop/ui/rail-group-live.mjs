// 右列のグループを開いている間の「新しい書き込みが届く」仕組み。
// 繋がっている間は Rust 側の WebSocket（hub_realtime_open、id だけのイベント `hub-realtime`）で新着を知り、
// 繋がっていない間・繋げなかったときは従来の定期取得（pollGroup）に戻る。呼び出し側は { sync, stop } だけを前提にする。
// 端末の認証もチケットも窓には渡らない（docs/hub-groups/DESIGN.md「サーバーの口 1」）。

export const LIVE_FOCUSED_MS = 10_000;
export const LIVE_UNFOCUSED_MS = 60_000;

/**
 * 開いているグループを定期的に取り直す。
 * - isActive() が偽（右列が隠れている・グループが閉じている）の間は何も予約せず止まる。再開は返り値の sync() で行う。
 * - 窓に焦点があれば 10 秒、無ければ 60 秒。重なった取得は 1 本にする。
 * - 隠れている間のタイマー停止（右列の切り離し窓の一時停止）は window.setTimeout の差し替えがそのまま効く。
 */
export function pollGroup({ win, refresh, isActive, isFocused, focusedMs = LIVE_FOCUSED_MS, unfocusedMs = LIVE_UNFOCUSED_MS }) {
  let timer = 0, running = false, stopped = false, scheduledFor = 0;
  const clear = () => { if (timer) { win.clearTimeout(timer); timer = 0; } scheduledFor = 0; };
  const delay = () => (isFocused() ? focusedMs : unfocusedMs);
  function schedule() {
    clear();
    if (stopped || !isActive()) return;
    scheduledFor = delay();
    timer = win.setTimeout(tick, scheduledFor);
  }
  async function tick() {
    timer = 0;
    if (stopped || !isActive()) { clear(); return; }
    if (running) { schedule(); return; }
    running = true;
    try { await refresh(); } catch { /* 次の周で取り直す。失敗の表示は refresh 側 */ }
    finally { running = false; }
    schedule();
  }
  const onFocus = () => { if (!stopped && isActive()) { clear(); void tick(); } };
  const onBlur = () => schedule();
  const onVisibility = () => { if (win.document?.visibilityState === "hidden") clear(); else onFocus(); };
  win.addEventListener?.("focus", onFocus);
  win.addEventListener?.("blur", onBlur);
  win.document?.addEventListener?.("visibilitychange", onVisibility);
  schedule();
  return {
    // 右列の表示・非表示、グループの開閉が変わったとき。止まっていれば再開し、動いていて間隔が変わるなら組み直す。
    sync() { if (stopped) return; if (!isActive()) { clear(); return; } if (!timer && !running) schedule(); else if (timer && scheduledFor !== delay()) schedule(); },
    stop() {
      stopped = true; clear();
      win.removeEventListener?.("focus", onFocus);
      win.removeEventListener?.("blur", onBlur);
      win.document?.removeEventListener?.("visibilitychange", onVisibility);
    },
    get waiting() { return timer !== 0; },
  };
}

export const REALTIME_EVENT = "hub-realtime";
export const REALTIME_STATUS_EVENT = "hub-realtime-status";

// 開く・閉じるの IPC は 1 本ずつ順に流す（閉じるが後から開くを追い越して、新しい購読を止めないため）。
let realtimeQueue = Promise.resolve();
const inOrder = (task) => { const next = realtimeQueue.then(task, task); realtimeQueue = next.catch(() => {}); return next; };

/**
 * 公開グループは communityId、非公開グループ（DM）は conversationId の新着を購読する。
 * - realtime: { invoke, listen(name, handler) -> Promise<unlisten> }。handler は payload を受ける。
 * - 通知は「取り直してよい」合図だけ（中身は refresh が読む）。取得が重なれば最後に 1 回だけ追加で取る。
 * - 繋がっている間は定期取得を止め、閉じた・失敗した状態が来たら定期取得を再開する。
 * - isActive() が偽（右列が隠れた・一時停止・グループが閉じた）なら接続を閉じる。sync() で再開。
 */
export function realtimeGroup(options) {
  const { win, refresh, isActive, group, realtime } = options;
  const topics = group.kind === "private" ? { communities: [], dm: true } : { communities: [group.id], dm: false };
  const matches = (event) => group.kind === "private"
    ? event?.type === "dm-message" && event.conversationId === group.id
    : event?.type === "group-message" && event.communityId === group.id;
  let stopped = false, wanted = false, open = false, pulling = false, again = false;
  let unlisten = [], listening = null;
  const poller = pollGroup({ ...options, isActive: () => isActive() && !open });

  async function pull() {
    if (pulling) { again = true; return; }
    pulling = true;
    try { do { again = false; if (stopped || !isActive()) break; try { await refresh(); } catch { /* 表示は refresh 側 */ } } while (again); }
    finally { pulling = false; }
  }
  const onEvent = (payload) => { if (!stopped && matches(payload)) void pull(); };
  const onStatus = (payload) => {
    if (stopped) return;
    const was = open;
    open = payload?.state === "open";
    if (open && !was) void pull(); // 繋がる前に届かなかった分を取り直す
    poller.sync();
  };
  function attach() {
    if (listening) return listening;
    listening = Promise.all([realtime.listen(REALTIME_EVENT, onEvent), realtime.listen(REALTIME_STATUS_EVENT, onStatus)]).then((fns) => {
      if (stopped) fns.forEach((fn) => { try { fn?.(); } catch { /* 解除済み */ } }); else unlisten = fns;
    }, () => { listening = null; });
    return listening;
  }
  async function connect() {
    wanted = true;
    await attach();
    if (stopped || !wanted) return;
    try { await inOrder(() => realtime.invoke("hub_realtime_open", topics)); }
    catch { open = false; poller.sync(); } // 繋げない：定期取得のまま
  }
  function disconnect() {
    if (!wanted) return;
    wanted = false; open = false;
    void inOrder(() => realtime.invoke("hub_realtime_close")).catch(() => {});
    poller.sync();
  }
  const onVisibility = () => api.sync();
  win.document?.addEventListener?.("visibilitychange", onVisibility);
  const api = {
    sync() {
      if (stopped) return;
      if (isActive() && !wanted) void connect();
      else if (!isActive() && wanted) disconnect();
      poller.sync();
    },
    stop() {
      if (stopped) return;
      disconnect();
      stopped = true;
      poller.stop();
      win.document?.removeEventListener?.("visibilitychange", onVisibility);
      unlisten.forEach((fn) => { try { fn?.(); } catch { /* 解除済み */ } });
      unlisten = [];
    },
    get waiting() { return poller.waiting; },
    get realtime() { return open; },
  };
  api.sync();
  return api;
}

/** 差し替え点：グループの変化を購読する。refresh は「取り直してよい」合図で、中身は rail-chat が読む。返り値は { sync, stop }。 */
export function subscribeGroup(options) {
  return options?.realtime && options.group?.id ? realtimeGroup(options) : pollGroup(options);
}
