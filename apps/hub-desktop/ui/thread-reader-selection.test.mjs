import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json',import.meta.url)), { JSDOM } = require('jsdom');
// Only resolve the candidate's original imports to their actual readonly Hub files.
const source = readFileSync(new URL('./thread-reader.src.mjs', import.meta.url), 'utf8').replaceAll("'../../hub/lib/", "'" + new URL('../../hub/lib/',import.meta.url).href);
const { createThreadReader } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const posts = () => Array.from({ length: 125 }, (_, index) => ({ id: `p${index+1}`, no: index+1, displayName: 'Reader', body: index === 50 ? '日本語 literal <script> ABC special' : `本文 ${index+1}`, createdAt: '2026-10-07', replyToPostId: index === 1 ? 'p1' : null, voteSummary: { score: index === 1 ? 6 : 0, up: 6, down: 0 } }));
function fixture({ selection = null, state = {}, values = posts(), current = () => true } = {}) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  let scrolls = 0;
  const reader = createThreadReader(dom.window.document, { thread: { id: 'thread' }, posts: values, viewer: { lastReadPostNo: 1 }, state, selection, isCurrent: current,
    renderPost(post) { const card = dom.window.document.createElement('article'); card.dataset.id = post.id; card.textContent = post.body; card.scrollIntoView = () => { scrolls++; }; return card; } });
  const change = (label, value) => { const control = reader.querySelector(`[aria-label="${label}"]`); control.value = value; control.dispatchEvent(new dom.window.Event(label === 'スレッド内を検索' ? 'input' : 'change')); };
  return { dom, reader, state, values, change, attach() { dom.window.document.querySelector('main').append(reader); }, get scrolls() { return scrolls; }, close() { reader.dispose(); dom.window.close(); } };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const cards = f => [...f.reader.querySelectorAll('article')].map(card=>card.dataset.id);
const notice = f => [...f.reader.querySelectorAll('[role="status"]')].map(node=>node.textContent).join(' ');

test('actual loaded reply ID/no selects its 50-row page and focuses only after attachment', async () => {
  const state = { query: 'unrelated', mode: 'guide', author: 'other', source: true, page: 0 };
  const f = fixture({ selection: { replyPostId: 'p51', postNo: 51, showReplies: true, page: 99 }, state });
  try {
    assert.equal(state.mode, 'flat'); assert.equal(state.query, ''); assert.equal(state.author, ''); assert.equal(state.source, false); assert.equal(state.page, 1);
    assert.equal(cards(f).length, 50); assert.equal(cards(f)[0], 'p51'); assert.equal(f.scrolls, 0); assert.equal(f.dom.window.document.activeElement.tagName, 'BODY');
    f.attach(); await tick();
    assert.equal(f.dom.window.document.activeElement.dataset.id, 'p51'); assert.equal(f.scrolls, 1); assert.match(notice(f), /通知の投稿 #51 を表示しました/);
    assert.equal(f.reader.querySelectorAll('script').length, 0); assert.match(f.dom.window.document.activeElement.textContent, /literal <script>/);
  } finally { f.close(); }
});

test('post-number-only selection uses actual loaded row position, not an assumed dense post number', async () => {
  const values = posts().filter(post=>post.no > 70), f = fixture({ values, selection: { postNo: 101 } });
  try { assert.equal(f.state.page, 0); f.attach(); await tick(); assert.equal(f.dom.window.document.activeElement.dataset.id, 'p101'); } finally { f.close(); }
});

test('missing, hidden, ambiguous and mismatched ID/no targets report unavailable without claiming focus', async () => {
  for (const kind of ['missing', 'deletedAt', 'moderatedAt', 'viewerMuted', 'viewerBlocked', 'mismatch', 'duplicate']) {
    const values = posts(); let selection = { replyPostId: 'p51', postNo: 51 };
    if (kind === 'missing') selection.replyPostId = 'absent';
    else if (kind === 'mismatch') selection.postNo = 52;
    else if (kind === 'duplicate') values.push({ ...values[50] });
    else values[50][kind] = kind.endsWith('At') ? '2026-10-07' : true;
    const state = { query: 'ABC special', page: 0 }, f = fixture({ values, selection, state });
    try { f.attach(); await tick(); assert.match(notice(f), /通知の投稿を表示できません/); assert.equal(f.scrolls, 0); assert.equal(state.query, 'ABC special'); assert.equal(f.dom.window.document.activeElement.tagName, 'BODY'); } finally { f.close(); }
  }
});

test('later user search and repeated reader creation keep state without reapplying the notification', async () => {
  const state = {}, selection = { replyPostId: 'p51', postNo: 51, showReplies: true }, f = fixture({ state, selection });
  try {
    f.attach(); await tick(); f.change('スレッド内を検索', '本文 125'); assert.equal(state.query, '本文 125'); assert.equal(state.page, 0); assert.deepEqual(cards(f), ['p125']);
    const again = createThreadReader(f.dom.window.document, { thread: { id: 'thread' }, posts: f.values, state, selection, renderPost(post) { const card=f.dom.window.document.createElement('article');card.dataset.id=post.id;return card; } });
    f.reader.replaceWith(again); await tick(); assert.deepEqual([...again.querySelectorAll('article')].map(n=>n.dataset.id), ['p125']); assert.equal(state.query, '本文 125'); assert.equal(f.scrolls, 1); again.dispose();
  } finally { f.close(); }
});

test('a newly requested distinct target can select again in the same reading state', async () => {
  const state = {}, first = fixture({ state, selection: { replyPostId: 'p51' } });
  try { first.attach(); await tick(); first.change('スレッド内を検索', 'unrelated'); } finally { first.close(); }
  const next = fixture({ state, selection: { replyPostId: 'p101', postNo: 101 } });
  try { assert.equal(state.query, ''); assert.equal(state.page, 2); assert.equal(cards(next)[0], 'p101'); next.attach(); await tick(); assert.equal(next.scrolls, 1); } finally { next.close(); }
});

test('user action before attachment cancels late target focus and leaves their new page intact', async () => {
  const f = fixture({ selection: { replyPostId: 'p51' } });
  try { [...f.reader.querySelectorAll('button')].find(b=>b.textContent==='次の50件').click(); f.attach(); await tick(); assert.equal(f.state.page, 2); assert.equal(f.scrolls, 0); assert.equal(f.dom.window.document.activeElement.tagName, 'BODY'); } finally { f.close(); }
});

test('account/view changes and disposal cancel pending attachment focus', async () => {
  for (const disposed of [false, true]) {
    let current = true; const f = fixture({ selection: { replyPostId: 'p51' }, current: () => current });
    try { if (disposed) f.reader.dispose(); else current = false; f.attach(); await tick(); assert.equal(f.scrolls, 0); assert.equal(f.dom.window.document.activeElement.tagName, 'BODY'); assert.doesNotMatch(notice(f), /表示しました/); } finally { f.close(); }
  }
  const state = { query: 'kept', page: 0 }, f = fixture({ selection: { replyPostId: 'p51' }, state, current: () => false });
  try { assert.equal(state.query, 'kept'); assert.equal(state.notificationSelectionKey, undefined); } finally { f.close(); }
});

test('invalid actual row identity or a changed target before attachment cannot claim arrival', async () => {
  for (const changed of ['invalidNo','no','id','hidden']) {
    const values=posts(); if(changed==='invalidNo') values[50].no='51';
    const f=fixture({values,selection:{replyPostId:'p51'}});
    try {
      if(changed==='no') values[50].no=52; else if(changed==='id') values[50].id='other'; else if(changed==='hidden') values[50].viewerBlocked=true;
      f.attach();await tick();assert.equal(f.scrolls,0);assert.match(notice(f),/通知の投稿を表示できません/);
    } finally {f.close();}
  }
});

test('invalid selection shapes and out-of-range page hints are unavailable, never silently applied', () => {
  for (const selection of [{ postNo: 0 }, { postNo: Number.MAX_SAFE_INTEGER + 1 }, { replyPostId: 'p51\n' }, { replyPostId: 'p51', unsafe: true }, { showReplies: 1 }, { page: 4 }]) {
    const state = { query: 'ABC special' }, f = fixture({ selection, state });
    try { assert.match(notice(f), /通知の投稿を表示できません/); assert.equal(state.query, 'ABC special'); assert.equal(f.scrolls, 0); } finally { f.close(); }
  }
});

test('existing search/tree/guide/pagination behavior remains available after arrival', async () => {
  const f = fixture({ selection: { replyPostId: 'p51' } });
  try {
    f.attach(); await tick(); f.change('スレッド内を検索', 'abc special'); assert.deepEqual(cards(f), ['p51']);
    f.change('スレッド内を検索', ''); f.change('投稿の表示', 'tree'); assert.equal(f.reader.querySelector('[data-id="p2"]').style.marginInlineStart, '12px');
    f.change('投稿の表示', 'guide'); assert.deepEqual(cards(f), ['p1','p2']);
    f.change('投稿の表示', 'flat'); assert.equal(cards(f).length, 50); [...f.reader.querySelectorAll('button')].find(b=>b.textContent==='次の50件').click(); assert.equal(cards(f)[0], 'p51');
  } finally { f.close(); }
});
