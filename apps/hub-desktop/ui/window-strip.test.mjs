import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const html = read('index.html');
const shell = read('desktop-shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = read('tokens.css');

test('window controls are a fixed group of their own, not part of the toolbar flow', () => {
  const toolbar = html.slice(html.indexOf('<header class="app-toolbar"'), html.indexOf('</header>'));
  assert.ok(!toolbar.includes('window-controls'), 'toolbar no longer holds the controls');
  const strip = /<div class="window-strip"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html)[1];
  for (const id of ['window-minimize', 'window-maximize', 'window-close']) assert.ok(strip.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('</header>') < html.indexOf('class="window-strip"'));
});

test('the window controls sit at the right end of the 52px toolbar row, with no band of their own above it', () => {
  // 2026-11-07 owner: the 28px strip above the toolbar was wasted space.
  assert.match(shell, /--window-strip-h:\s*0px/);
  assert.match(shell, /#hub-shell:has\(> \.window-strip:not\(\[hidden\]\)\) \{ --window-controls-w: calc\(var\(--icon-btn\) \* 3 \+ var\(--icon-btn-gap\) \* 2 \+ var\(--space-2\)\); \}/);
  const rule = /#hub-shell > \.window-strip \{([^}]*)\}/.exec(shell)[1];
  assert.match(rule, /position:\s*fixed/);
  assert.match(rule, /top:\s*0/);
  assert.match(rule, /right:\s*0/);
  assert.match(rule, /width:\s*var\(--window-controls-w\)/);
  assert.match(rule, /height:\s*var\(--titlebar-h\)/);
  assert.ok(!/left:\s*0/.test(rule), 'the strip is only as wide as the controls, so the rest of the row stays draggable');
  assert.match(read('icon-buttons.css'), /\.window-control,[\s\S]*?width: var\(--icon-btn\);/);
  assert.match(tokens, /--titlebar-h:\s*52px/);
});

test('the toolbar and the raised rail head both leave room for the controls and never sit under them', () => {
  assert.match(shell, /#hub-shell \.app-toolbar \{[^}]*padding:\s*0 var\(--window-controls-w\) 0 0/);
  assert.match(shell, /\.rail-open \.rail \.rail-activity-head \{[^}]*padding-right:\s*max\(var\(--space-4\), calc\(var\(--window-controls-w\) - 48px\)\)/);
  const z = Number(/#hub-shell > \.window-strip \{[^}]*z-index:\s*(\d+)/.exec(shell)[1]);
  assert.ok(z > 42, 'above the omnibox (41), the browser strip (42) and the rail (31)');
  const app = read('app.js');
  assert.match(app, /\.window-strip"\)\.hidden = false/);
});

test('the browser view keeps the same left-column title row and inset as every other view', () => {
  const side = read('sidebar-context.css');
  assert.ok(!/browser-active \.sidebar > \.brand\s*\{\s*display:\s*none/.test(side));
  assert.match(read('browser-vertical-tabs.css'), /#sidebar-tabs \{ padding:0 var\(--space-2\) var\(--space-3\)/);
});

test('the timeline header row is a slim row holding its menu button, so it never overlaps the first post', () => {
  const social = read('desktop-social.css');
  assert.match(social, /#hub-shell #view-feed > \.page-header:not\(#_\)[^{]*\{\s*display: flex;[^}]*height: var\(--control-h\);/);
  assert.match(social, /#view-feed > \.page-header > \.page-actions:not\(#_\)[^{]*\{\s*position: static;/);
});
