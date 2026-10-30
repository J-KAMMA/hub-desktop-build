const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeId = value => Number.isSafeInteger(value) && value > 0;
const validResult = value => exact(value, ['accepted', 'reference', 'surface'])
  && value.accepted === true && value.reference === true && value.surface === 'pi';

/** The main backend owns admission. This bridge sends only the selected fixture tab. */
export function initBrowserAiControl({listen, invoke, isReady, sendToAi, readResult, now = Date.now}) {
  let disposed = false, active = null, lastRequest = 0, unlisten;
  const ack = (request, outcome, result = null) => {
    try { return Promise.resolve(invoke('browser_ai_control_ack', {requestId: request.requestId, tabId: request.tabId, outcome, result})).catch(() => {}); }
    catch { return Promise.resolve(); }
  };
  async function receive(payload) {
    const time = now();
    if (disposed || !exact(payload, ['requestId', 'expiresAt', 'tabId', 'port'])
      || !safeId(payload.requestId) || payload.requestId <= lastRequest || !safeId(payload.tabId)
      || !Number.isSafeInteger(payload.port) || payload.port < 1024 || payload.port > 65535 || payload.port === 3020
      || !Number.isSafeInteger(payload.expiresAt) || !Number.isSafeInteger(time) || time < 0
      || payload.expiresAt <= time || payload.expiresAt - time > 20000) return;
    const request = {requestId: payload.requestId, expiresAt: payload.expiresAt, tabId: payload.tabId, port: payload.port};
    lastRequest = request.requestId;
    if (active) { await ack(request, 'failed'); return; }
    active = request;
    const alive = () => { const time = now(); return !disposed && active === request && Number.isSafeInteger(time) && time >= 0 && time < request.expiresAt; };
    const url = `http://127.0.0.1:${request.port}/__hub_ai_fixture`;
    let outcome = 'failed', result = null, phase;
    const markPhase = value => { if (['source_changed', 'extracting', 'extract_failed', 'staging', 'draft_failed', 'draft_refused', 'draft_not_ready', 'draft_snapshot_failed', 'draft_navigation_changed', 'draft_context_invalid', 'draft_history_changed', 'accepted'].includes(value)) phase = value; };
    try {
      if (isReady() !== true) outcome = 'not_ready';
      else {
        const accepted = await sendToAi({tabId: request.tabId, url, isCurrent: alive}, markPhase);
        if (!alive()) outcome = 'superseded';
        else if (accepted === true) {
          const current = await readResult(request.tabId, url);
          if (!alive()) outcome = 'superseded';
          else if (validResult(current)) { outcome = 'applied'; result = {accepted: true, reference: true, surface: 'pi'}; }
          else outcome = 'reference_unavailable';
        } else if (['source_changed', 'extract_failed', 'draft_failed', 'draft_refused', 'draft_not_ready', 'draft_snapshot_failed', 'draft_navigation_changed', 'draft_context_invalid', 'draft_history_changed'].includes(phase)) outcome = phase;
      }
    } catch { outcome = alive() ? 'failed' : 'superseded'; }
    finally { if (active === request) active = null; }
    if (!disposed) await ack(request, outcome, result);
  }
  const ready = Promise.resolve().then(() => listen('browser-ai-control', event => receive(event.payload))).then(stop => {
    if (disposed) stop?.(); else unlisten = stop;
  }).catch(() => {});
  return {ready, destroy() { disposed = true; active = null; unlisten?.(); }};
}
