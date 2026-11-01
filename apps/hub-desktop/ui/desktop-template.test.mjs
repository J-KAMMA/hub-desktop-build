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
  for (const view of ['feed', 'notifications', 'profile', 'community', 'threads', 'search', 'hubpedia', 'articles', 'bookmarks', 'lists']) assert.equal(templateFor(view), 'stream', view);
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
