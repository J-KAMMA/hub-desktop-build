import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEMPLATES, templateFor } from './desktop-template.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('every view and detail maps to one of the five templates (or the browser)', () => {
  const html = read('index.html');
  const views = [...html.matchAll(/data-view-panel="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(views.length >= 30);
  for (const view of views) assert.ok(TEMPLATES.includes(templateFor(view)), `${view} -> ${templateFor(view)}`);
  assert.deepEqual(TEMPLATES.slice(0, 5), ['stream', 'wide', 'reading', 'split', 'settings']);
});

test('the route map of DESIGN-SYSTEM section 5 holds for the desktop views', () => {
  for (const view of ['feed', 'notifications', 'profile', 'threads', 'community', 'search', 'hubpedia', 'bookmarks', 'lists']) assert.equal(templateFor(view), 'stream', view);
  for (const view of ['videos', 'music', 'market', 'games', 'books', 'compute', 'node', 'code']) assert.equal(templateFor(view), 'wide', view);
  for (const view of ['messages', 'mail']) assert.equal(templateFor(view), 'split', view);
  for (const view of ['settings', 'wallet', 'cart', 'order']) assert.equal(templateFor(view), 'settings', view);
  assert.equal(templateFor('browser'), 'browser');
  assert.equal(templateFor('detail', 'article'), 'reading');
  assert.equal(templateFor('detail', 'hubpedia_article'), 'reading');
  assert.equal(templateFor('detail', 'video'), 'wide');
  assert.equal(templateFor('detail', 'community'), 'stream');
  assert.equal(templateFor('detail', ''), 'stream');
  assert.equal(templateFor('unknown-view'), 'stream');
});

test('main column is centered on the window in every template, clamped so it never overlaps the context column', () => {
  const css = read('desktop-layouts.css');
  const m = css.match(/#hub-shell\.app-shell:not\(\[data-template="browser"\]\) \.view:not\(#view-browser\):not\(#view-ai\) \{([^}]*)\}/);
  assert.ok(m, 'generic template width rule exists');
  assert.match(m[1], /margin-inline:\s*max\(0px, min\(calc\(50vw - var\(--left-w\) - var\(--sb-gutter\) - var\(--main-w\) \/ 2\), calc\(100% - var\(--main-w\)\)\)\) auto;/);
  assert.match(css, /--left-w: calc\(var\(--rail-w\) \+ var\(--desktop-sidebar-width, clamp\(210px, 13.5vw, 250px\)\)\)/);
  assert.match(css, /\.sidebar-collapsed \{ --left-w: var\(--rail-w\); \}/);
  assert.match(css, /\.rail-open:not\(\[data-template="browser"\]\) \.view:not\(#view-browser\):not\(#view-ai\) \{ margin-inline: auto; \}/);
  assert.match(m[1], /max-width:\s*var\(--main-w\)/);
  for (const tpl of ['stream', 'wide', 'reading', 'split', 'settings']) {
    assert.ok(TEMPLATES.includes(tpl));
    assert.doesNotMatch(css, new RegExp('data-template="' + tpl + '"[^{]*\\.view[^{]*\\{[^}]*margin-inline:\\s*auto'), tpl);
  }
  assert.match(read('components.css'), /#hub-shell \.view:not\(#view-browser\):not\(#view-ai\) \{ margin-inline: auto; \}/);
  assert.match(css, /--main-w: var\(--ds-col-wide\)/);
});
