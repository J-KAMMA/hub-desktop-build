import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigationTarget, addressSuggestions, browserShortcut, filterBrowserTabs } from './browser-navigation.mjs';

test('addresses and searches share a bounded explicit target policy', () => {
  assert.equal(navigationTarget(' example.com/docs '), 'https://example.com/docs');
  assert.equal(navigationTarget('localhost:8080/a'), 'http://localhost:8080/a');
  assert.equal(navigationTarget('[::1]:8080'), 'http://[::1]:8080/');
  assert.equal(navigationTarget('127.0.0.1.evil.example'), 'https://127.0.0.1.evil.example/');
  assert.equal(navigationTarget('研究 & code', 'duckduckgo'), 'https://duckduckgo.com/?q=%E7%A0%94%E7%A9%B6%20%26%20code');
  assert.match(navigationTarget('query', 'unknown'), /^https:\/\/www.google.com/);
  assert.equal(navigationTarget(' '), null);
  for (const raw of ['javascript:alert(1)', 'file:///secret', 'data:text/html,x', 'https://', 'https://name:password@example.com', 'https://example.com\u0000', 'x'.repeat(8193)]) assert.throws(() => navigationTarget(raw), /invalid_url/);
});

test('local candidates favor existing tabs and deduplicate favorites/history', () => {
  const tabs = [{ id: 4, url: 'https://example.com/', title: '研究ノート' }];
  const candidates = addressSuggestions('研究', { tabs, favorites: [{ url: tabs[0].url, title: '研究ノート' }], history: [{ url: 'https://other.example/', title: '研究資料' }, { url: 'javascript:alert(1)', title: '研究' }] });
  assert.equal(candidates[0].kind, 'navigate'); assert.equal(candidates[1].kind, 'tab'); assert.equal(candidates[1].id, 4); assert.equal(candidates[2].kind, 'history'); assert.equal(candidates.length, 3);
  assert.equal(addressSuggestions('', { history: Array.from({ length: 40 }, (_, i) => ({ url: `https://${i}.example/` })) }).length, 7);
  assert.equal(addressSuggestions('javascript:alert(1)').length, 0);
});

test('shortcuts distinguish restoration and tab traversal from ordinary editing', () => {
  assert.equal(browserShortcut({ key: 't', ctrlKey: true, shiftKey: true }), 'restore');
  assert.equal(browserShortcut({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'previous');
  assert.equal(browserShortcut({ key: 'l', ctrlKey: true }), 'address');
  assert.equal(browserShortcut({ key: '9', ctrlKey: true }), 'tab-9');
  assert.equal(browserShortcut({ key: 'w', ctrlKey: true, shiftKey: true }), null);
  assert.equal(browserShortcut({ key: 'ArrowLeft', altKey: true }), 'back');
  assert.equal(browserShortcut({ key: 'f' }), null);
});

test('tab search shortcut is closed and retains existing Ctrl/meta semantics', () => {
  for (const key of ['a', 'A']) {
    assert.equal(browserShortcut({ key, ctrlKey: true, shiftKey: true }), 'tabs');
    assert.equal(browserShortcut({ key, metaKey: true, shiftKey: true }), 'tabs');
    for (const modifiers of [{}, { ctrlKey: true }, { shiftKey: true }, { ctrlKey: true, shiftKey: true, altKey: true }, { altKey: true, shiftKey: true }]) assert.equal(browserShortcut({ key, ...modifiers }), null);
  }
  assert.equal(browserShortcut({ key: '5', ctrlKey: true }), 'tab-5');
  assert.equal(browserShortcut({ key: '5', ctrlKey: true, shiftKey: true }), null);
  assert.equal(browserShortcut({ key: 'F5' }), 'reload');
});
test('private tab shortcut accepts only Ctrl/meta Shift N without Alt',()=>{
  for(const key of ['n','N']){assert.equal(browserShortcut({key,ctrlKey:true,shiftKey:true}),'private-new');assert.equal(browserShortcut({key,metaKey:true,shiftKey:true}),'private-new');}
  for(const modifiers of [{},{ctrlKey:true},{shiftKey:true},{ctrlKey:true,shiftKey:true,altKey:true},{altKey:true,shiftKey:true}])assert.equal(browserShortcut({key:'N',...modifiers}),null);
});
test('prototype names, nonstring keys and controls never become shortcut actions', () => {
  for (const key of ['__proto__', 'constructor', 'toString', '1\n', 'a\u0000', '\ta', 'a\u007f', null, undefined, 65, {}, '']) {
    for (const modifiers of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { altKey: true }]) assert.equal(browserShortcut({ key, ...modifiers }), null);
  }
});
test('filter preserves original references/order/duplicate URLs and does not mutate', () => {
  const a = Object.freeze({ id: 4, title: 'One', url: 'https://same.example/' }), b = Object.freeze({ id: 2, title: 'Two', url: a.url }), c = Object.freeze({ id: 9, title: '', url: '' });
  const tabs = Object.freeze([a, b, c]), result = filterBrowserTabs(tabs); assert.notEqual(result, tabs); assert.deepEqual(result, tabs); assert.equal(result[0], a); assert.equal(result[1], b); assert.equal(result[2], c);
  assert.deepEqual(filterBrowserTabs(tabs, 'same.example'), [a, b]); assert.deepEqual(tabs.map(t => t.id), [4, 2, 9]);
});
test('only positive safeinteger IDs survive, including width/0/max/max+1 boundaries', () => {
  const good = [{ id: 1 }, { id: Number.MAX_SAFE_INTEGER }], invalid = [null, undefined, [], 'tab', {}, { id: 0 }, { id: -0 }, { id: -1 }, { id: 1.5 }, { id: NaN }, { id: Infinity }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: '2' }, { id: 2n }, { id: true }];
  assert.deepEqual(filterBrowserTabs([...invalid, ...good]), good);
  assert.deepEqual(filterBrowserTabs(null), []); assert.deepEqual(filterBrowserTabs({ tabs: good }), []); assert.deepEqual(filterBrowserTabs(Array(2)), []);
});
test('duplicate IDs keep first before filtering, never substitute later match', () => {
  const first = { id: 7, title: 'original', url: '' }, later = { id: 7, title: 'MATCH', url: 'https://match.example' }, different = { id: 8, title: 'match', url: '' };
  assert.deepEqual(filterBrowserTabs([first, later, different]), [first, different]); assert.deepEqual(filterBrowserTabs([first, later, different], 'match'), [different]);
});
test('query casefold and whitespace AND tokens match title/full URL across fields', () => {
  const a = { id: 1, title: 'Research NOTE', url: 'https://EXAMPLE.com/deep/path?question=Unicode#section' }, b = { id: 2, title: 'research', url: 'https://example.com/other' };
  for (const query of [' RESEARCH\tdeep\nUNICODE  ', 'example section note', 'NOTE\u3000question']) assert.deepEqual(filterBrowserTabs([a, b], query), [a]);
  assert.deepEqual(filterBrowserTabs([a, b], 'research absent'), []); assert.deepEqual(filterBrowserTabs([a, b], ' \n\t\u3000 '), [a, b]);
});
test('localized newtab/pinned/discarded labels searchable with exact boolean flags', () => {
  const blank = { id: 1, title: '', url: '', pinned: true, discarded: true }, pinned = { id: 2, title: 'article', url: 'https://example.com/', pinned: true }, normal = { id: 3, title: 'normal', url: 'https://else.example/', pinned: 'false', discarded: {} };
  assert.deepEqual(filterBrowserTabs([blank, pinned, normal], '新しいタブ 固定 メモリ解放'), [blank]); assert.deepEqual(filterBrowserTabs([blank, pinned, normal], '固定'), [blank, pinned]); assert.deepEqual(filterBrowserTabs([blank, pinned, normal], 'メモリ解放'), [blank]); assert.deepEqual(filterBrowserTabs([blank, pinned, normal], '新しいタブ'), [blank]);
});
test('malformed text/query objects do not stringify or execute; literal hostile text searchable', () => {
  const throws = { toString() { throw Error('must not coerce'); } }, bad = { id: 1, title: throws, url: throws }, literal = { id: 2, title: '<script>boom()</script> __proto__', url: 'https://literal.example/<img>?x=constructor' };
  assert.deepEqual(filterBrowserTabs([bad, literal], 'object'), []); assert.deepEqual(filterBrowserTabs([bad, literal], '__proto__'), [literal]); assert.deepEqual(filterBrowserTabs([bad, literal], '<script> constructor'), [literal]);
  for (const query of [null, undefined, 1, [], throws]) assert.deepEqual(filterBrowserTabs([bad, literal], query), [bad, literal]);
});
test('controls/unpaired UTF16 and long query remain literal local matching', () => {
  const tab = { id: 1, title: 'prefix\u0000suffix \ud800 ' + 'x'.repeat(513), url: '' };
  for (const query of ['prefix\u0000suffix', '\ud800', 'x'.repeat(513)]) assert.deepEqual(filterBrowserTabs([tab], query), [tab]); assert.deepEqual(filterBrowserTabs([tab], '\u0001'), []);
});
test('unknown/prototype engine names use Google URL/title, valid engines unchanged', () => {
  for (const engine of ['unknown', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'Google', null, undefined]) {
    assert.equal(navigationTarget('research topic', engine), 'https://www.google.com/search?q=research%20topic');
    const result = addressSuggestions('research topic', { engine }); assert.equal(result[0].url, 'https://www.google.com/search?q=research%20topic'); assert.equal(result[0].title, 'Googleで「research topic」を検索');
    assert.equal(navigationTarget('example.com', engine), 'https://example.com/');
  }
  for (const [engine, url, label] of [['google', 'https://www.google.com/search?q=', 'Google'], ['duckduckgo', 'https://duckduckgo.com/?q=', 'DuckDuckGo'], ['bing', 'https://www.bing.com/search?q=', 'Bing']]) {
    assert.equal(navigationTarget('research topic', engine), `${url}research%20topic`); const result = addressSuggestions('research topic', { engine }); assert.equal(result[0].url, `${url}research%20topic`); assert.equal(result[0].title, `${label}で「research topic」を検索`);
  }
});

test('search suggestions say which provider receives the words, while inferred URLs say open',()=>{
 const search=addressSuggestions('日本語の検索')[0];assert.equal(search.title,'Googleで「日本語の検索」を検索');assert.equal(search.detail,'Web検索 · Google');assert.equal(addressSuggestions('example.org/path')[0].title,'このアドレスを開く');
});

test('Chrome conventions: Alt+D/F6, Ctrl+PgUp/PgDn, Ctrl+D and cache-bypassing reload', async () => {
  const { completeDotCom, selectionSearchUrl } = await import('./browser-navigation.mjs');
  assert.equal(browserShortcut({ key: 'd', altKey: true }), 'address');
  assert.equal(browserShortcut({ key: 'F6' }), 'address');
  assert.equal(browserShortcut({ key: 'F6', ctrlKey: true }), null);
  assert.equal(browserShortcut({ key: 'PageDown', ctrlKey: true }), 'next');
  assert.equal(browserShortcut({ key: 'PageUp', ctrlKey: true }), 'previous');
  assert.equal(browserShortcut({ key: 'PageUp' }), null);
  assert.equal(browserShortcut({ key: 'd', ctrlKey: true }), 'favorite');
  assert.equal(browserShortcut({ key: 'D', ctrlKey: true, shiftKey: true }), null);
  assert.equal(browserShortcut({ key: 'F5', ctrlKey: true }), 'hard-reload');
  assert.equal(browserShortcut({ key: 'R', ctrlKey: true, shiftKey: true }), 'hard-reload');
  assert.equal(browserShortcut({ key: 'r', ctrlKey: true }), 'reload');
  assert.equal(browserShortcut({ key: 'Backspace' }), null);
  assert.equal(browserShortcut({ key: 'Backspace', altKey: true }), null);
  assert.equal(completeDotCom(' Example '), 'https://www.example.com/');
  assert.equal(completeDotCom('my-site'), 'https://www.my-site.com/');
  for (const value of ['example.org', 'two words', '-bad', 'bad-', '', 'a/b', '研究']) assert.equal(completeDotCom(value), null);
  assert.equal(selectionSearchUrl(' 研究\n\t code ', 'duckduckgo'), 'https://duckduckgo.com/?q=%E7%A0%94%E7%A9%B6%20code');
  assert.equal(selectionSearchUrl('a'.repeat(500)).length, 'https://www.google.com/search?q='.length + 200);
  for (const value of ['', ' \n ', null, 1, {}]) assert.equal(selectionSearchUrl(value), null);
});
