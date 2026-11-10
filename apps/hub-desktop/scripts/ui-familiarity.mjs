// First-use familiarity cost for the Hub Desktop UI cost model (Jakob's law).
// Pure functions only; geometry comes from ui-cost.mjs --familiarity.
// The expert model in ui-cost.mjs is unchanged: total = expert + share * familiarity.
import {readFileSync} from 'node:fs';

export const conventions = JSON.parse(readFileSync(new URL('./ui-familiarity-conventions.json', import.meta.url), 'utf8'));
export const FAM = Object.fromEntries(Object.entries(conventions.constants).map(([k, v]) => [k, v.value]));

// Same formula as ui-cost.mjs (kept here so the pure model can be tested without a browser).
export const EXPERT = {base: 0.1, fitts: 0.15, hick: 0.15};
export const expertStep = ({fittsId = 0, hickBits = 0}) => EXPERT.base + EXPERT.fitts * fittsId + EXPERT.hick * hickBits;

// Items a first-time user looks at before finding the element.
// el: {region, rank, n, iconMatch, labelVisible, parent?}; convRegions: [region]; regionSize: {region: n}.
export function searchItems(el, convRegions, regionSize, c = FAM) {
  const recognisable = el.iconMatch || el.labelVisible;
  const perItem = recognisable ? c.tScan : c.tHover;
  const inConv = convRegions.includes(el.region);
  let seconds = 0, items = 0;
  if (!inConv) {
    // Exhausts the conventional place first (glance per item), then searches where it really is.
    // A conventional place that is empty in Hub still costs one glance.
    const miss = convRegions.reduce((a, r) => a + (regionSize[r] || 1), 0) / Math.max(1, convRegions.length);
    items += miss; seconds += miss * c.tScan;
    const found = el.iconMatch ? el.rank : (el.n + 1) / 2;
    items += found; seconds += found * perItem;
  } else if (!el.iconMatch) {
    // Right place, unfamiliar icon: the icon gives no guidance, so the scan is random within the region.
    const found = (el.n + 1) / 2;
    items += found; seconds += found * perItem;
  }
  if (el.parent) { const p = searchItems(el.parent, el.parent.convRegions || convRegions, regionSize, c); items += p.items; seconds += p.seconds; }
  return {items: +items.toFixed(3), seconds: +seconds.toFixed(3)};
}

// Power law of practice: the k-th use costs k^-alpha of the first.
export const practice = (k, alpha = FAM.alpha) => Math.pow(k, -alpha);
export function meanPractice(horizon = FAM.horizon, alpha = FAM.alpha) {
  let s = 0; for (let k = 1; k <= horizon; k++) s += practice(k, alpha); return s / horizon;
}

// Expected seconds per execution for a population where `share` of executions come from users in their first `horizon` uses.
export const blended = (expertSeconds, firstUseSeconds, share, c = FAM) => expertSeconds + share * firstUseSeconds * meanPractice(c.horizon, c.alpha);

// Measured rows -> rows with firstUse. A proposal changes one element (or every rail element with target "*rail")
// and may grow the rail, which adds Hick bits to every rail click and one item to random rail scans.
// rows: [{id, weight, conv, el:{region,rank,n,iconMatch,labelVisible}, fittsId, hickBits}]
export function applyProposals(rows, regionSize, proposals = [], geometry = {}) {
  let size = {...regionSize};
  let out = rows.map(r => ({...r, el: {...r.el}}));
  for (const p of proposals) {
    const grow = p.railGrows || 0;
    if (grow) {
      size = {...size, rail: size.rail + grow};
      out = out.map(r => r.el.region !== 'rail' ? r : {...r, el: {...r.el, n: r.el.n + grow}, hickBits: +Math.log2(r.el.n + grow + 1).toFixed(3)});
    }
    out = out.map(r => {
      if (p.target === '*rail' ? r.el.region !== 'rail' : r.id !== p.target) return r;
      const el = {...r.el, ...p.change};
      const next = {...r, el};
      if (p.change.region === 'rail' && r.el.region !== 'rail') {
        el.n = size.rail;
        const g = geometry[p.id];
        if (g) next.fittsId = g.fittsId;
        next.hickBits = +Math.log2(size.rail + 1).toFixed(3);
      } else if (p.hickN) {
        const g = geometry[p.id];
        if (g) next.fittsId = g.fittsId;
        next.hickBits = +Math.log2(p.hickN + 1).toFixed(3);
      }
      return next;
    });
  }
  return {rows: out.map(r => ({...r, expert: +expertStep(r).toFixed(3), firstUse: searchItems(r.el, r.conv, size).seconds})), regionSize: size};
}

// rows: [{weight, expert, firstUse}] -> weighted totals per share.
export function totals(rows, shares = FAM.shares, c = FAM) {
  const out = {expert: +rows.reduce((a, r) => a + r.weight * r.expert, 0).toFixed(2)};
  for (const p of shares) out['p' + p] = +rows.reduce((a, r) => a + r.weight * blended(r.expert, r.firstUse, p, c), 0).toFixed(2);
  return out;
}
