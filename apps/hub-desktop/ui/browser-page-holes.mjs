// The page of a browser tab is a native child webview stacked above this document. Any HTML layer of the
// bundled UI that overlaps the page stage (the browser menu, rail tooltips, suggestion lists, popovers)
// would be hidden under it, so the page is cut out exactly where those layers are (browser_page_holes).
// Rects are measured on every layout change and sent in page-relative CSS px; Native converts them with
// the scale in effect when it clips, so a monitor change cannot leave a hole at a stale size or place.

export const PAGE_OVERLAY_SELECTOR = [
  '#browser-menu', '#browser-suggestions', '.rail-tooltip', '[data-page-overlay]',
  '[role="tooltip"]', '[role="menu"]', '[role="listbox"]', '[role="dialog"]', 'dialog[open]',
].join(',');
export const MAX_PAGE_HOLES = 16;
// Room for focus rings and the menu shadow edge.
const MARGIN = 2;

/** Page-relative holes for the given viewport rects, rounded outward and clipped to the stage. */
export function pageHoles(stage, rects) {
  const holes = [];
  if (!stage || !(stage.width > 0) || !(stage.height > 0)) return holes;
  for (const rect of rects) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
    const left = Math.max(stage.left, rect.left - MARGIN), top = Math.max(stage.top, rect.top - MARGIN);
    const right = Math.min(stage.right, rect.right + MARGIN), bottom = Math.min(stage.bottom, rect.bottom + MARGIN);
    if (!(right > left) || !(bottom > top)) continue;
    const x = Math.floor(left - stage.left), y = Math.floor(top - stage.top);
    holes.push([x, y, Math.ceil(right - stage.left) - x, Math.ceil(bottom - stage.top) - y]);
    if (holes.length === MAX_PAGE_HOLES) break;
  }
  return holes;
}

function visibleRect(window, element) {
  if (element.hidden || element.closest('[hidden]')) return null;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** Keeps the page clipped under every visible HTML overlay while the browser stage is shown. */
export function createBrowserPageHoles({ window, document, stage, invoke, isActive }) {
  if (!stage || typeof invoke !== 'function' || typeof isActive !== 'function') throw Error('browser_page_holes_invalid');
  let sent = '[]', frame = null, destroyed = false;
  const request = window.requestAnimationFrame?.bind(window) ?? (callback => window.setTimeout(callback, 16));
  const cancel = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window);
  function measure() {
    if (!isActive()) return [];
    const area = stage.getBoundingClientRect();
    const rects = [];
    for (const element of document.querySelectorAll(PAGE_OVERLAY_SELECTOR)) {
      if (stage.contains(element)) continue;
      const rect = visibleRect(window, element);
      if (rect) rects.push(rect);
    }
    return pageHoles(area, rects);
  }
  function sync() {
    frame = null;
    if (destroyed) return;
    // Leaving the browser clears the holes natively; forget them so the next entry sends afresh.
    if (!isActive()) { sent = '[]'; return; }
    const rects = measure(), key = JSON.stringify(rects);
    if (key === sent) return;
    sent = key;
    void Promise.resolve(invoke('browser_page_holes', { rects })).catch(() => { sent = ''; });
  }
  const schedule = () => { if (frame === null && !destroyed) frame = request(sync); };
  const mutations = new window.MutationObserver(schedule);
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'open'] });
  const sizes = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(schedule) : null;
  sizes?.observe(stage);
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  schedule();
  return {
    schedule, measure,
    destroy() {
      if (destroyed) return; destroyed = true;
      if (frame !== null) cancel(frame);
      mutations.disconnect(); sizes?.disconnect();
      window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true);
    },
  };
}
