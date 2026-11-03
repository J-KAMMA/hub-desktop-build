import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const root = new URL('./', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const app = readFileSync(new URL('app.js', root), 'utf8');
const css = readFileSync(new URL('desktop-views.css', root), 'utf8').replaceAll('\r\n', '\n');
const document = new JSDOM(html).window.document;
const rule = (selector) => {
  const at = css.lastIndexOf(selector + ' {');
  assert.ok(at >= 0, selector);
  return css.slice(at, css.indexOf('}', at));
};

test('the tab row hides its scrollbar and keeps 16px tab padding with a fixed minimum width', () => {
  assert.match(css, /#hub-shell \.view \.page-tabs \{[^}]*scrollbar-width: none/);
  assert.match(css, /\.page-tabs::-webkit-scrollbar \{ display: none/);
  const tab = rule('#hub-shell .view > :is(.view-head, .page-header):has(> .page-tabs:not(:empty)) > .page-tabs > :is(.page-tab, [role="tab"], button)');
  assert.match(tab, /min-width: 88px/);
  assert.match(tab, /padding-inline: var\(--ds-space-4\)/);
  assert.match(tab, /flex: 0 0 auto/);
});

test('header refresh buttons are 32px icon-only buttons with an aria-label and a tooltip', () => {
  for (const id of ['video', 'music', 'compute', 'research', 'wallet', 'node', 'notifications', 'messages', 'mail', 'rail']) {
    const button = document.getElementById(`${id}-refresh`);
    assert.ok(button, id);
    assert.ok(button.classList.contains('btn-icon'), id);
    assert.equal(button.getAttribute('aria-label'), '更新');
    assert.equal(button.getAttribute('title'), '更新');
    assert.equal(button.textContent.trim(), '', `${id} has no text label`);
    assert.ok(button.querySelector('svg'), id);
  }
  assert.ok(document.getElementById('feed-sources-toggle').classList.contains('btn-icon'));
  assert.match(rule('#hub-shell .btn-icon:not(#_)'), /width: var\(--ds-icon-btn-compact\)[\s\S]*border: 0[\s\S]*border-radius: 50%[\s\S]*background: transparent/);
  assert.match(css, /\.btn-icon:not\(#_\):hover:not\(:disabled\) \{ background: var\(--interactive\)/);
});

test('chips are transparent hairline pills at weight 400 and 13px; selected is a line, never a fill', () => {
  const chip = rule('#hub-shell :is(.chip, .sidebar-chip, .scope, .chip-row > button, .segmented > button, .scopes > button):not(#_)');
  assert.match(chip, /height: var\(--ds-chip-h\)/);
  assert.match(chip, /border: 1px solid var\(--divider\)/);
  assert.match(chip, /border-radius: var\(--ds-radius-pill\)/);
  assert.match(chip, /background: transparent/);
  assert.match(chip, /font-size: var\(--ds-type-meta-size\)/);
  assert.match(chip, /font-weight: var\(--ds-weight-text\)/);
  const on = css.slice(css.indexOf('.sidebar-chip[aria-pressed="true"], .scope.on'));
  const body = on.slice(on.indexOf('{'), on.indexOf('}'));
  assert.match(body, /border-color: var\(--ds-chip-selected-line\)/);
  assert.match(body, /background: transparent/);
  assert.doesNotMatch(body, /background: var\(--text\)/);
  assert.match(css, /\.view-chip-host\) \{[^}]*padding: var\(--ds-space-4\) var\(--ds-page-inset\)[^}]*border-bottom: 1px solid var\(--divider\)/);
});

test('the 新しい作品 row is hidden when the count is zero', () => {
  assert.match(app, /section\.hidden = section\.dataset\.count === "0"/);
  assert.match(css, /research-feed-updates\[data-count="0"\] \{ display: none/);
});

test('there are four button kinds, defined once, with the rail post button as a 48px squircle', () => {
  assert.match(css, /:is\(\.btn-primary, \.approve\):not\(#_\) \{ border-color: var\(--ds-btn-primary-line\)/);
  assert.match(css, /:is\(\.btn-secondary, \.deny, \.head-action\):not\(#_\) \{ border-color: var\(--divider\); background: transparent/);
  assert.match(css, /:is\(\.btn-ghost, button\.ghost\):not\(#_\) \{ border-color: transparent; background: transparent/);
  assert.match(css, /#hub-shell \.btn-icon:not\(#_\) \{/);
  const base = rule('#hub-shell :where(.btn, .approve, .deny, .head-action, button.ghost):not(#_)');
  assert.match(base, /border-radius: var\(--ds-radius-pill\)/);
  assert.match(base, /box-shadow: none/);
  const post = rule('#hub-shell .icon-rail #desktop-compose:not([hidden]):not(#_)');
  assert.match(post, /height: 48px/);
  assert.ok(post.includes('border-radius: var(--ds-radius-card)'));
  assert.match(post, /background: transparent/);
});
