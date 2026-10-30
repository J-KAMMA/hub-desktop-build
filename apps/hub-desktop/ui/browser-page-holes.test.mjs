import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {pageHoles, createBrowserPageHoles, MAX_PAGE_HOLES} from './browser-page-holes.mjs';
import {initRailTooltips} from './rail-tooltip.mjs';

const box = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height, x: left, y: top});
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

test('holes are page-relative, rounded outward and clipped to the stage', () => {
  const stage = box(108, 44, 1764, 988);
  // The browser menu as laid out on a maximized 1920x1080 window, flush with the stage's right edge minus 8 px.
  assert.deepEqual(pageHoles(stage, [box(1504, 50, 360, 535)]), [[1394, 4, 364, 539]]);
  // A rail tooltip that starts left of the stage only cuts the part over the page.
  assert.deepEqual(pageHoles(stage, [box(64, 52.5, 80, 25)]), [[0, 6, 38, 30]]);
  // Outside the stage, empty, or no stage: nothing.
  assert.deepEqual(pageHoles(stage, [box(0, 0, 50, 50), box(500, 500, 0, 10), null]), []);
  assert.deepEqual(pageHoles(box(0, 0, 0, 0), [box(10, 10, 10, 10)]), []);
  assert.equal(pageHoles(stage, Array.from({length: 40}, (_, i) => box(200 + i, 100, 10, 10))).length, MAX_PAGE_HOLES);
});

function fixture() {
  const dom = new JSDOM('<body><nav class="icon-rail"><button aria-label="マーケット"></button></nav><div id="browser-stage"></div><div id="browser-menu" role="menu" hidden></div><div id="other-menu" role="menu"></div></body>', {pretendToBeVisual: true});
  const {window} = dom, {document} = window;
  Object.defineProperties(window, {innerWidth: {value: 1920, configurable: true}, innerHeight: {value: 1032, configurable: true}});
  const rects = new Map([
    ['browser-stage', box(108, 44, 1764, 988)], ['browser-menu', box(1504, 50, 360, 535)], ['other-menu', box(10, 10, 40, 40)],
  ]);
  window.HTMLElement.prototype.getBoundingClientRect = function () { return rects.get(this.id) ?? box(0, 0, 0, 0); };
  const button = document.querySelector('.icon-rail button');
  rects.set('', box(8, 50, 40, 38));
  const calls = [];
  const state = {active: true};
  const holes = createBrowserPageHoles({window, document, stage: document.querySelector('#browser-stage'), invoke: async (name, args) => { calls.push({name, args}); }, isActive: () => state.active});
  return {dom, window, document, rects, calls, state, holes, button};
}

test('the open browser menu and a rail tooltip over the page are cut out; closing them restores the page', async t => {
  const f = fixture();
  t.after(() => { f.holes.destroy(); f.dom.window.close(); });
  await tick();
  // Nothing visible over the stage yet: no call (the native state starts empty).
  assert.equal(f.calls.length, 0);
  const menu = f.document.querySelector('#browser-menu');
  menu.hidden = false; await tick();
  assert.deepEqual(f.calls.at(-1), {name: 'browser_page_holes', args: {rects: [[1394, 4, 364, 539]]}});

  // The rail tooltip, positioned by rail-tooltip.mjs, overlaps the page's left edge.
  const dispose = initRailTooltips(f.document, {delay: 0}), tip = f.document.querySelector('.rail-tooltip');
  f.rects.set('rail-tooltip', box(56, 50, 120, 30));
  f.button.dispatchEvent(new f.window.MouseEvent('pointerover', {bubbles: true}));
  await tick();
  assert.equal(tip.hidden, false);
  assert.deepEqual(f.calls.at(-1).args.rects, [[1394, 4, 364, 539], [0, 4, 70, 34]]);

  // The menu grows (a submenu): the hole follows the measured size, not a size taken when it opened.
  f.rects.set('browser-menu', box(1504, 50, 360, 700)); menu.append(f.document.createElement('p')); await tick();
  assert.deepEqual(f.calls.at(-1).args.rects[0], [1394, 4, 364, 704]);

  f.button.dispatchEvent(new f.window.MouseEvent('pointerout', {bubbles: true, relatedTarget: f.document.body}));
  menu.hidden = true; await tick();
  assert.deepEqual(f.calls.at(-1).args.rects, []);
  dispose();
});

test('the stage moving or shrinking re-measures; leaving the browser forgets what was sent', async t => {
  const f = fixture();
  t.after(() => { f.holes.destroy(); f.dom.window.close(); });
  f.document.querySelector('#browser-menu').hidden = false; await tick();
  const before = f.calls.length;
  // Restored window on the same monitor: the stage is narrower and the menu follows it.
  f.rects.set('browser-stage', box(108, 44, 1476, 833)); f.rects.set('browser-menu', box(1216, 50, 360, 535));
  f.window.dispatchEvent(new f.window.Event('resize')); await tick();
  assert.equal(f.calls.length, before + 1);
  assert.deepEqual(f.calls.at(-1).args.rects, [[1106, 4, 364, 539]]);
  f.state.active = false; f.window.dispatchEvent(new f.window.Event('resize')); await tick();
  assert.equal(f.calls.length, before + 1);
  // Re-entering with the same menu open sends it again: Native cleared its holes on exit.
  f.state.active = true; f.window.dispatchEvent(new f.window.Event('resize')); await tick();
  assert.deepEqual(f.calls.at(-1).args.rects, [[1106, 4, 364, 539]]);
  assert.equal(f.calls.length, before + 2);
});
