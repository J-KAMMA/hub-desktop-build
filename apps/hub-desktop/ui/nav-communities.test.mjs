import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createNavCommunities, joinedCommunities, renderNavCommunities, NAV_COMMUNITY_LIMIT, NAV_COMMUNITY_TTL_MS } from './nav-communities.mjs';

const make = (count) => Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: `名前${i}`, imageUrl: '' }));
const data = (count, joined = count) => ({
  communities: make(count),
  memberships: make(joined).map((c) => ({ communityId: c.id, status: 'active' })),
});

test('only joined communities appear, at most five, and the sixth makes a more flag', () => {
  assert.equal(joinedCommunities(data(7)).rows.length, NAV_COMMUNITY_LIMIT);
  assert.equal(joinedCommunities(data(7)).more, true);
  assert.equal(joinedCommunities(data(3)).more, false);
  assert.equal(joinedCommunities(data(4, 2)).rows.length, 2);
  assert.deepEqual(joinedCommunities({ communities: make(2), memberships: [{ communityId: 'c0', status: 'banned' }] }).rows, []);
  assert.deepEqual(joinedCommunities(null).rows, []);
  assert.equal(joinedCommunities({ communities: [{ id: 'c0', name: 'a', unreadCount: 3 }], memberships: [{ communityId: 'c0', status: 'muted' }] }).rows[0].unread, 3);
});

test('rows are context-column buttons with a face and a name, the current one is marked, and the last row links to the list', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host');
  const opened = []; let all = 0;
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(3)), { current: 'c1', onOpen: (row) => opened.push(row.id), onAll: () => { all++; } });
  const buttons = [...host.querySelectorAll('button')];
  assert.equal(buttons.length, 4);
  assert.equal(host.hidden, false);
  assert.equal(buttons[0].querySelector('.nav-community-face').textContent, '名');
  assert.equal(buttons[1].getAttribute('aria-current'), 'true');
  assert.equal(buttons[0].hasAttribute('aria-current'), false);
  buttons[2].click(); buttons[3].click();
  assert.deepEqual(opened, ['c2']);
  assert.equal(all, 1);
  assert.equal(buttons[3].textContent, 'すべて見る');
  renderNavCommunities(dom.window.document, host, { rows: [] }, {});
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

test('an unread count becomes an outlined count badge, never a fill', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host');
  renderNavCommunities(dom.window.document, host, joinedCommunities({ communities: [{ id: 'a', name: 'A', unreadCount: 120 }], memberships: [{ communityId: 'a', status: 'active' }] }), {});
  assert.equal(host.querySelector('.nav-badge').textContent, '99+');
  const css = readFileSync(new URL('./desktop-shell.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('#hub-shell .nav-badge {'), css.indexOf('#hub-shell .nav-badge[hidden]'));
  assert.match(rule, /border: 1px solid var\(--ds-badge-count-line\)/);
  assert.match(rule, /background: transparent/);
  assert.match(rule, /height: var\(--ds-badge-h\)/);
});

test('the list is read once and kept for five minutes; signed-out draws nothing and reads nothing', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host');
  let reads = 0, signed = true, clock = 1000;
  const nav = createNavCommunities({ document: dom.window.document, host, load: async () => { reads++; return data(2); }, signedIn: () => signed, now: () => clock });
  await nav.refresh();
  await nav.refresh();
  assert.equal(reads, 1);
  assert.equal(host.querySelectorAll('.nav-community').length, 3);
  clock += NAV_COMMUNITY_TTL_MS - 1;
  await nav.refresh();
  assert.equal(reads, 1);
  clock += 2;
  await nav.refresh();
  assert.equal(reads, 2);
  nav.setCurrent('c0');
  assert.equal(host.querySelector('[aria-current="true"]').dataset.communityId, 'c0');
  signed = false;
  await nav.refresh();
  assert.equal(host.hidden, true);
  assert.equal(reads, 2);
  signed = true;
  nav.clear();
  await nav.refresh();
  assert.equal(reads, 3);
});

test('a failed read draws nothing and a later refresh reads again', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host');
  let reads = 0;
  const nav = createNavCommunities({ document: dom.window.document, host, load: async () => { reads++; if (reads === 1) throw new Error('x'); return data(1); }, signedIn: () => true });
  await nav.refresh();
  assert.equal(host.hidden, true);
  await nav.refresh();
  assert.equal(host.querySelectorAll('.nav-community').length, 2);
});

test('gold is a line and never a fill in any ui stylesheet', () => {
  const files = readdirSync(new URL('./', import.meta.url)).filter((name) => name.endsWith('.css'));
  assert.ok(files.length > 30);
  const gold = /background(?:-color|-image)?\s*:\s*[^;{}]*var\(--(?:emphasis|action|champagne|accent-base)\b/;
  const read = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const file of files) assert.doesNotMatch(read(file), gold, `${file}: no gold fill`);
  for (const file of ['desktop-luxe.css', 'desktop-views.css', 'desktop-layouts.css']) {
    assert.doesNotMatch(read(file), /gradient/, `${file}: no gradient`);
  }
});

test('joined communities live in the community view context column, not in the left rail', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const rail = html.match(/<nav class="icon-rail"[\s\S]*?<\/nav>/)[0];
  assert.doesNotMatch(rail, /nav-communities|nav-community/);
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(contextView === "community" && desktopAccount\.state === "registered"\) \{[\s\S]*?sidebarContext\.append\(communitiesHost\);/);
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host');
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(2)), {});
  assert.ok([...host.querySelectorAll('.nav-community')].every((button) => button.classList.contains('sidebar-context-item')), 'rows reuse the context-column row style');
});
