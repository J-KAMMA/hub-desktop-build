const PHASES = Object.freeze(['workspace', 'agents', 'attach', 'lastSession', 'feed', 'node', 'games', 'browserFetch', 'browserRender', 'browserRefresh', 'feedReadyWait', 'feedLocal', 'feedConnected', 'feedDistributed', 'feedFederated', 'lastSessionRead', 'historyRender', 'workHistory']);
const MARKS = Object.freeze(['moduleReady', 'uiWired', 'feedReady', 'startupComplete', 'feedApplied', 'feedSuperseded', 'feedFailed']);
const MAX_MS = 86_400_000, MAX_CALLS = 1_000_000;
const noop = () => {};

export function createDesktopControlMetrics({ now = () => performance.now() } = {}) {
  const phases = new Map(PHASES.map(name => [name, { name, calls: 0, totalMs: 0, busyMs: 0, active: 0, busyStart: 0 }])), marks = new Map();
  let lastNow = 0;
  const read = () => {
    try { const value = now(); if (Number.isFinite(value) && value >= 0) lastNow = Math.max(lastNow, Math.min(MAX_MS, value)); } catch { /* Observation never changes the operation. */ }
    return lastNow;
  };
  function begin(name) {
    const phase = phases.get(name);
    if (!phase) return noop;
    const start = read(); let finished = false;
    phase.calls = Math.min(MAX_CALLS, phase.calls + 1);
    if (phase.active++ === 0) phase.busyStart = start;
    return () => {
      if (finished) return;
      finished = true; const end = read();
      phase.totalMs = Math.min(MAX_MS, phase.totalMs + end - start);
      if (--phase.active === 0) phase.busyMs = Math.min(MAX_MS, phase.busyMs + end - phase.busyStart);
    };
  }
  return {
    begin,
    async measure(name, action) { const finish = begin(name); try { return await action(); } finally { finish(); } },
    mark(name) { if (MARKS.includes(name) && !marks.has(name)) marks.set(name, { name, atMs: read() }); },
    snapshot() {
      const at = read();
      return { elapsedMs: at, phases: [...phases.values()].map(({ name, calls, totalMs, busyMs, active, busyStart }) => ({ name, calls, totalMs, busyMs: Math.min(MAX_MS, busyMs + (active ? at - busyStart : 0)), inFlight: Math.min(MAX_CALLS, active) })), marks: [...marks.values()].map(mark => ({ ...mark })) };
    },
  };
}
