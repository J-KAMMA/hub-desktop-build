import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createNavCommunities, joinedCommunities, listedCommunities, renderNavCommunities, NAV_COMMUNITY_LIMIT, NAV_COMMUNITY_TTL_MS } from './nav-communities.mjs';

const make = (count) => Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: `名前${i}`, imageUrl: '' }));
const data = (count, joined = count) => ({
  communities: make(count),
  memberships: make(joined).map((c) => ({ communityId: c.id, status: 'active' })),
});

test('only joined communities appear, at most eight, and the ninth makes a more flag', () => {
  assert.equal(NAV_COMMUNITY_LIMIT, 8);
  assert.equal(joinedCommunities(data(12)).rows.length, NAV_COMMUNITY_LIMIT);
  assert.equal(joinedCommunities(data(12)).more, true);
  assert.equal(joinedCommunities(data(8)).more, false);
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
  assert.equal(buttons[3].textContent, 'すべて');
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

test('the list is read once and kept for five minutes; signed-out lists only public popular ones', async () => {
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
  nav.clear();
  await nav.refresh();
  assert.equal(reads, 3);
  assert.equal(host.hidden, true, 'no public community in the sample means nothing to list');
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

// 2026-11-10（所有者の決定）: 既定の paper / charcoal は弁柄色を主ボタンの面に塗る。その塗りは desktop-calm.css にだけ置き、
// 必ず paper / charcoal に限る。ほかのスタイルシートと、金のテンプレート（noir・ivory）では、強調色は今までどおり線だけ。
test('gold is a line and never a fill in any ui stylesheet; only desktop-calm.css fills with the accent, and only for paper and charcoal', () => {
  const files = readdirSync(new URL('./', import.meta.url)).filter((name) => name.endsWith('.css'));
  assert.ok(files.length > 30);
  const gold = /background(?:-color|-image)?\s*:\s*[^;{}]*var\(--(?:emphasis|action|champagne|accent-base)\b/;
  const read = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const file of files.filter((name) => name !== 'desktop-calm.css')) assert.doesNotMatch(read(file), gold, `${file}: no gold fill`);
  const calm = read('desktop-calm.css');
  const scope = 'html:is([data-template="paper"], [data-template="charcoal"]) ';
  let fills = 0;
  for (const [, selector, body] of calm.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    assert.ok(selector.trim().startsWith(scope), `desktop-calm.css: ${selector.trim().slice(0, 60)} is scoped to paper and charcoal`);
    assert.doesNotMatch(selector, /noir|ivory/, 'desktop-calm.css never styles the gold templates');
    if (gold.test(body)) fills += 1;
  }
  assert.ok(fills >= 1, 'the primary button hover fill lives in desktop-calm.css');
  assert.doesNotMatch(calm, /gradient|box-shadow|animation|#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'desktop-calm.css: tokens only, no gradient, shadow or animation');
  for (const file of ['desktop-luxe.css', 'desktop-views.css', 'desktop-layouts.css']) {
    assert.doesNotMatch(read(file), /gradient/, `${file}: no gradient`);
  }
});

test('joined communities live in the community view context column, not in the left rail', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const rail = html.match(/<nav class="icon-rail"[\s\S]*?<\/nav>/)[0];
  assert.doesNotMatch(rail, /nav-communities|nav-community/);
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(contextView === "community"\) \{[\s\S]*?sidebarContext\.append\(communitiesHost\);/);
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host');
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(2)), {});
  assert.ok([...host.querySelectorAll('.nav-community')].every((button) => button.classList.contains('sidebar-context-item')), 'rows reuse the context-column row style');
});

test('the open community shows 投稿 / メンバー / 設定 under its row, with no channel rows', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host');
  const picked = [];
  const subs = [{ key: 'posts', label: '投稿', selected: true }, { key: 'members', label: 'メンバー', selected: false }, { key: 'settings', label: '設定', selected: false }];
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(3)), { current: 'c1', subs, onSub: (key, row) => picked.push([key, row.id]) });
  const labels = [...host.querySelectorAll('button')].map((button) => button.textContent);
  assert.deepEqual(labels.slice(0, 2), ['名名前0', '名名前1']);
  assert.deepEqual(labels.slice(2, 5), ['投稿', 'メンバー', '設定']);
  assert.equal(host.querySelector('.nav-community-sub[data-section="posts"]').getAttribute('aria-current'), 'page');
  assert.equal(labels.some((label) => label.includes('チャンネル')), false);
  host.querySelector('[data-section="members"]').click();
  assert.deepEqual(picked, [['members', 'c1']]);
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(3)), { current: 'c9', subs });
  assert.equal(host.querySelectorAll('.nav-community-sub').length, 0);
});

test('an item with a node is placed as is under the open community (the channel list); other items stay text rows', () => {
  const dom = new JSDOM('<div id="h"></div>');
  const document = dom.window.document, host = document.querySelector('#h');
  const node = document.createElement('nav'); node.className = 'community-channels';
  renderNavCommunities(document, host, joinedCommunities(data(2)), { current: 'c1', subs: [{ key: 'channels', node }, { key: 'shared', label: '共有', selected: true }] });
  const kids = [...host.children].map((child) => child.className.split(' ')[0] || child.tagName);
  assert.deepEqual(kids.slice(0, 4), ['nav-community', 'nav-community', 'community-channels', 'nav-community-sub']);
  assert.equal(host.querySelector('.nav-community-sub').getAttribute('data-keep-text'), '');
});

test('an open community outside 参加中 is added first, with its children right below it', () => {
  const dom = new JSDOM('<div id="h"></div>');
  const host = dom.window.document.getElementById('h');
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(2)), {
    current: 'x', extra: { id: 'x', name: '外', imageUrl: '' }, subs: [{ key: 'shared', label: '共有' }],
  });
  const kids = [...host.children].map((n) => n.dataset.communityId ?? n.dataset.section ?? 'all');
  assert.deepEqual(kids, ['x', 'shared', 'c0', 'c1', 'all']);
  assert.equal(host.children[0].getAttribute('aria-current'), 'true');
});

test('with nothing joined, the list falls back to a few public popular communities; private ones never appear', () => {
  const communities = [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `公開${i}`, visibility: 'public', memberCount: i })),
    { id: 'secret', name: '非公開', visibility: 'private', memberCount: 999 },
    { id: 'hot', name: '動き', visibility: 'public', memberCount: 1, recentMessageCount: 500 },
  ];
  const listed = listedCommunities({ communities, memberships: [] });
  assert.equal(listed.rows.length, 5);
  assert.equal(listed.rows[0].id, 'hot');
  assert.ok(!listed.rows.some((row) => row.id === 'secret'));
  assert.equal(listed.suggested, true);
  const joined = listedCommunities({ communities, memberships: [{ communityId: 'p1', status: 'active' }] });
  assert.deepEqual(joined.rows.map((row) => row.id), ['p1']);
  assert.equal(joined.suggested, undefined);
});

test('the community tree puts the list before the おすすめ / 人気 rows', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('const readingFilterRows'));
  assert.ok(body.indexOf('if (afterJoined) afterJoined();') < body.indexOf('for (const [key, label] of isThread'));
});

test('exactly one current row: the open community row, or its 共有/メンバー child when that is open', () => {
  const dom = new JSDOM('<div id="h"></div>');
  const host = dom.window.document.getElementById('h');
  const current = () => [...host.querySelectorAll('[aria-current]')];
  const subs = (selected) => [{ key: 'shared', label: '共有', selected: selected === 'shared' }, { key: 'members', label: 'メンバー', selected: selected === 'members' }];
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(2)), { current: 'c1', subs: subs('') });
  assert.equal(current().length, 1);
  assert.equal(current()[0].dataset.communityId, 'c1');
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(2)), { current: 'c1', subs: subs('members') });
  assert.equal(current().length, 1);
  assert.equal(current()[0].dataset.section, 'members');
  assert.equal(host.querySelector('[data-community-id="c1"]').dataset.open, 'true', 'the community row stays marked open, not current');
  renderNavCommunities(dom.window.document, host, joinedCommunities(data(2)), { current: '', subs: [] });
  assert.equal(current().length, 0, 'a directory list as the main content: no community row is current');
  assert.ok(!host.querySelector('.nav-community-all').hasAttribute('aria-current'));
});

test('the open community keeps its row when the sidebar redraws without the row (exactly one current row)', async () => {
  const dom = new JSDOM('<div id="h"></div>');
  const host = dom.window.document.getElementById('h');
  const nav = createNavCommunities({ document: dom.window.document, host, load: async () => data(2), signedIn: () => true });
  await nav.refresh();
  nav.setCurrent('x', [], { name: '外', imageUrl: '' });
  nav.setCurrent('x', []);
  const current = [...host.querySelectorAll('[aria-current]')];
  assert.equal(current.length, 1);
  assert.equal(current[0].dataset.communityId, 'x');
  nav.setCurrent('', []);
  nav.setCurrent('x', []);
  assert.equal(host.querySelector('[data-community-id="x"]'), null, 'a closed community does not come back');
});
