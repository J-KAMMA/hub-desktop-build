import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

// The owner does not want the left column to move: the icon rail is grid column 1 at --rail-w (56, or 208 when the menu is open),
// the context column is column 2, and no view, template or split changes either of them.
const files = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.css'));
const read = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('--rail-w is 56, becomes 208 only with the menu open, and nothing else sets it', () => {
  const setters = [];
  for (const file of files) for (const m of read(file).matchAll(/([^{}@;]+)\{[^{}]*--rail-w\s*:\s*([^;}]+)/g)) setters.push([file, m[1].trim(), m[2].trim()]);
  assert.deepEqual(setters.map(([file, selector, value]) => `${file}|${selector}|${value}`).sort(), [
    'desktop-shell.css|#hub-shell.rail-expanded|208px',
    'desktop-shell.css|#hub-shell|56px',
  ]);
});

test('every desktop shell grid starts with the rail column, so the rail sits at the same x in every view', () => {
  let desktopRules = 0;
  for (const file of files) {
    for (const [, selector, body] of read(file).matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const columns = body.match(/grid-template-columns:\s*([^;}]+)/)?.[1];
      const shellRule = selector.split(',').some((part) => /^(?:#hub-shell)?\.app-shell[^\s>+~]*$/.test(part.trim()));
      if (!columns || !shellRule) continue;
      if (/^(?:236px|72px)\b/.test(columns.trim())) continue; // 721 未満・旧い下限の既定（styles.css の先頭付近）
      desktopRules++;
      assert.match(columns.trim(), /^var\(--rail-w\)\s/, `${file}: ${selector.trim().slice(0, 90)} -> ${columns}`);
    }
  }
  assert.ok(desktopRules >= 10, `found ${desktopRules} shell grids`);
});

test('templates only change the width of the main column, never the grid', () => {
  for (const file of files) {
    for (const [, selector, body] of read(file).matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      if (!/data-template/.test(selector)) continue;
      assert.doesNotMatch(body, /grid-template|grid-column|grid-row|grid-area|--rail-w|--desktop-sidebar-width/, `${file}: ${selector.trim()}`);
    }
  }
  const layouts = read('desktop-layouts.css');
  assert.match(layouts, /\.app-shell\[data-template="wide"\] \{ --main-w: var\(--ds-col-wide\); \}/);
  assert.match(layouts, /\.app-shell\[data-template="reading"\] \{ --main-w: var\(--ds-col-reading\); \}/);
});

test('the rail and the context column are the first two items of the shell in the document', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const order = ['<header class="app-toolbar"', '<nav class="icon-rail"', '<aside class="sidebar"', '<main class="workspace-main"'].map((token) => html.indexOf(token));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), order.join(','));
});
