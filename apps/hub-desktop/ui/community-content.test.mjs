import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  CONTENT_TABS, createCommunityContentTabs, createCommunityPicker, createCommunityTalk, createThreadContentCard,
  linkToCommunity, parseCard, parseContentPage, parseThreads,
} from './community-content.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function rig(t, api) {
  const dom = new JSDOM('<main></main>'), document = dom.window.document, calls = [];
  const invoke = async (name, args) => { calls.push({ name, args }); return api(name, args); };
  t.after(() => dom.window.close());
  return { document, calls, invoke, main: document.querySelector('main') };
}
const item = (type, id, title) => ({ contentType: type, contentId: id, title, summary: '', authorName: '著者', authorHandle: 'w' });

test('four tabs in order; the first load asks the Hub for the chosen type', async (t) => {
  const r = rig(t, () => ({ items: [item('article', 'a1', '記事1')], nextCursor: null, canModerate: false }));
  const opened = [];
  const tabs = createCommunityContentTabs({ document: r.document, communityId: 'c-1', invoke: r.invoke, open: (type, entry) => opened.push([type, entry.contentId]) });
  r.main.append(tabs.root); await tabs.ready;
  assert.deepEqual([...r.main.querySelectorAll('.community-content-tabs button')].map((node) => node.textContent), CONTENT_TABS.map(([, label]) => label));
  assert.deepEqual(r.calls[0], { name: 'hub_detail', args: { name: 'community_content', ids: ['c-1', 'article'] } });
  r.main.querySelector('.community-content-title').click();
  assert.deepEqual(opened, [['article', 'a1']]);
  assert.equal(r.main.querySelector('.community-content-remove'), null);
});

test('switching tabs reloads, "もっと" appends with the cursor and drops duplicates', async (t) => {
  const pages = { 'video:': { items: [item('video', 'v1', '動画1')], nextCursor: '2026-11-02T00:00:00.000Z~v1', canModerate: false },
    'video:2026-11-02T00:00:00.000Z~v1': { items: [item('video', 'v1', '動画1'), item('video', 'v2', '動画2')], nextCursor: null, canModerate: false } };
  const r = rig(t, (name, args) => name === 'community_content' || name === 'community_content_page' ? pages[`${args.ids[1]}:${args.ids[2] ?? ''}`] ?? { items: [], nextCursor: null } : null);
  const tabs = createCommunityContentTabs({ document: r.document, communityId: 'c-1', invoke: (name, args) => r.invoke(args.name, args), initial: 'article' });
  r.main.append(tabs.root); await tabs.ready;
  r.main.querySelector('[data-type=video]').click(); await tick(); await tick();
  assert.deepEqual([...r.main.querySelectorAll('.community-content-title')].map((node) => node.textContent), ['動画1']);
  const more = [...r.main.querySelectorAll('button')].find((node) => node.textContent === 'もっと');
  assert.equal(more.hidden, false); more.click(); await tick(); await tick();
  assert.deepEqual([...r.main.querySelectorAll('.community-content-title')].map((node) => node.textContent), ['動画1', '動画2']);
  assert.deepEqual(r.calls.at(-1).args, { name: 'community_content_page', ids: ['c-1', 'video', '2026-11-02T00:00:00.000Z~v1'] });
});

test('moderators get a remove button that unlinks without deleting the content', async (t) => {
  const r = rig(t, (name) => name === 'hub_client_action' ? {} : { items: [item('article', 'a1', '外す記事')], nextCursor: null, canModerate: true });
  const tabs = createCommunityContentTabs({ document: r.document, communityId: 'c-1', invoke: r.invoke });
  r.main.append(tabs.root); await tabs.ready;
  r.main.querySelector('.community-content-remove').click(); await tick(); await tick();
  assert.deepEqual(r.calls.at(-1), { name: 'hub_client_action', args: { action: 'community_content_unlink', target: 'c-1', options: { contentType: 'article', contentId: 'a1' } } });
  assert.equal(r.main.querySelector('.community-content-title'), null);
});

test('a malformed page is shown as an error, never as content', async (t) => {
  const r = rig(t, () => ({ items: [{ contentType: 'article', contentId: '../x', title: 't' }], nextCursor: null }));
  const tabs = createCommunityContentTabs({ document: r.document, communityId: 'c-1', invoke: r.invoke, describeError: () => '読み込めませんでした。' });
  r.main.append(tabs.root); await tabs.ready;
  assert.equal(r.main.querySelector('.community-content-title'), null);
  assert.match(r.main.textContent, /読み込めませんでした/);
  assert.throws(() => parseContentPage({ items: [], nextCursor: 'a b' }, 'article'));
});

test('「<community>で話す」 opens or creates the thread and navigates to it; linked threads show a count', async (t) => {
  const r = rig(t, (name, args) => {
    if (args.name === 'community_content_mine') return { communities: [{ id: 'c-1', name: 'ひろば' }] };
    if (args.name === 'community_content_threads') return { threads: [{ communityId: 'c-1', communityName: 'ひろば', threadId: 't-1', title: '記事', postCount: 4 }] };
    return { threadId: 't-9', created: true };
  });
  const opened = [];
  const talk = createCommunityTalk({ document: r.document, contentType: 'article', contentId: 'a1', invoke: r.invoke, openThread: (id) => opened.push(id) });
  r.main.append(talk.root); await talk.ready;
  assert.equal(talk.root.hidden, false);
  assert.deepEqual([...r.main.querySelectorAll('.community-talk-button')].map((node) => node.textContent), ['ひろばで話す']);
  assert.equal(r.main.querySelector('.community-talk-thread').textContent, 'ひろば 4');
  r.main.querySelector('.community-talk-button').click(); await tick(); await tick();
  assert.deepEqual(r.calls.at(-1), { name: 'hub_client_action', args: { action: 'community_content_thread_open', target: 'c-1', options: { contentType: 'article', contentId: 'a1' } } });
  assert.deepEqual(opened, ['t-9']);
  r.main.querySelector('.community-talk-thread').click();
  assert.deepEqual(opened, ['t-9', 't-1']);
});

test('the talk control stays hidden when signed out and nothing is linked', async (t) => {
  const r = rig(t, (name, args) => { if (args.name === 'community_content_mine') throw Error('desktop_not_connected'); return { threads: [] }; });
  const talk = createCommunityTalk({ document: r.document, contentType: 'video', contentId: 'v1', invoke: r.invoke });
  r.main.append(talk.root); await talk.ready;
  assert.equal(talk.root.hidden, true);
});

test('the picker lists only my communities, defaults to none, and stays hidden without any', async (t) => {
  const some = rig(t, () => ({ communities: [{ id: 'c-1', name: 'ひろば' }] }));
  const picker = createCommunityPicker({ document: some.document, invoke: some.invoke });
  some.main.append(picker.root); await picker.ready;
  assert.equal(picker.root.hidden, false); assert.equal(picker.value(), '');
  picker.root.querySelector('select').value = 'c-1'; assert.equal(picker.value(), 'c-1');
  picker.reset(); assert.equal(picker.value(), '');
  const none = rig(t, () => ({ communities: [] }));
  const empty = createCommunityPicker({ document: none.document, invoke: none.invoke });
  await empty.ready; assert.equal(empty.root.hidden, true);
});

test('linking after a create sends only ids, skips when nothing is chosen, and reports failure', async () => {
  const calls = [];
  const invoke = async (name, args) => { calls.push([name, args]); if (args.target === 'bad') throw Error('x'); return {}; };
  assert.deepEqual(await linkToCommunity(invoke, '', 'article', 'a1'), { ok: true, skipped: true });
  assert.equal(calls.length, 0);
  assert.deepEqual(await linkToCommunity(invoke, 'c-1', 'article', 'a1'), { ok: true });
  assert.deepEqual(calls[0], ['hub_client_action', { action: 'community_content_link', target: 'c-1', options: { contentType: 'article', contentId: 'a1' } }]);
  assert.equal((await linkToCommunity(invoke, 'bad', 'article', 'a1')).ok, false);
});

test('the thread card links back to the content, and ordinary threads show nothing', async (t) => {
  const r = rig(t, () => ({ card: { contentType: 'video', contentId: 'v1', title: '動画題', communityName: 'ひろば' } }));
  const opened = [];
  const card = createThreadContentCard({ document: r.document, threadId: 't-1', invoke: r.invoke, openContent: (type, entry) => opened.push([type, entry.contentId]) });
  r.main.append(card.root); await card.ready;
  assert.equal(card.root.hidden, false); assert.match(card.root.textContent, /動画・ひろば/);
  r.main.querySelector('.community-thread-card-title').click(); assert.deepEqual(opened, [['video', 'v1']]);
  const plain = rig(t, () => ({ card: null }));
  const none = createThreadContentCard({ document: plain.document, threadId: 't-2', invoke: plain.invoke });
  await none.ready; assert.equal(none.root.hidden, true);
  assert.equal(parseCard({ card: null }), null);
  assert.throws(() => parseCard({ card: { contentType: 'post', contentId: 'x', title: 't', communityName: 'c' } }));
  assert.throws(() => parseThreads({ threads: [{ threadId: 'a b', communityId: 'c', communityName: 'n', title: 't', postCount: 1 }] }));
});

test('a fixed type draws no tab row of its own and loads only that type; moderator × stays', async (t) => {
  const r = rig(t, () => ({ items: [item('video', 'v1', '動画1')], nextCursor: null, canModerate: true }));
  const tabs = createCommunityContentTabs({ document: r.document, communityId: 'c-1', invoke: r.invoke, type: 'video' });
  r.main.append(tabs.root); await tabs.ready;
  assert.equal(r.main.querySelector('.community-content-tabs'), null);
  assert.deepEqual(r.calls.map((call) => call.args.ids.at(-1)), ['video']);
  assert.ok(r.main.querySelector('.community-content-remove'));
});
