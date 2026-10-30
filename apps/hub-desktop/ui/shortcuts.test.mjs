import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {shortcutFor, installShortcuts} from './shortcuts.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const key = (k, extra = {}) => ({key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra});

test('modifier combinations map to actions', () => {
  assert.equal(shortcutFor(key('3', {ctrlKey: true})), 'screen-3');
  assert.equal(shortcutFor(key('[', {ctrlKey: true})), 'back');
  assert.equal(shortcutFor(key(']', {ctrlKey: true})), 'forward');
  assert.equal(shortcutFor(key('ArrowLeft', {altKey: true})), 'back');
  assert.equal(shortcutFor(key('ArrowRight', {altKey: true})), 'forward');
  assert.equal(shortcutFor(key('l', {ctrlKey: true})), 'address');
  assert.equal(shortcutFor(key('n', {ctrlKey: true})), 'new');
  assert.equal(shortcutFor(key('\\', {ctrlKey: true})), 'sidebar');
  assert.equal(shortcutFor(key('|', {ctrlKey: true, shiftKey: true, code: 'IntlYen'})), 'rail');
  assert.equal(shortcutFor(key('\\', {ctrlKey: true, shiftKey: true})), 'rail');
});
test('n opens the post composer, but never while typing, composing, or with a dialog open', () => {
  assert.equal(shortcutFor(key('n')), 'compose');
  assert.equal(shortcutFor(key('n'), {typing: true}), null);
  assert.equal(shortcutFor({...key('n'), isComposing: true}), null);
  assert.equal(shortcutFor(key('n'), {dialogOpen: true}), null);
  assert.equal(shortcutFor(key('N', {shiftKey: true})), null);
  assert.equal(shortcutFor(key('n', {ctrlKey: true})), 'new');
});
test('single keys are off while typing, composing, or with a dialog open', () => {
  assert.equal(shortcutFor(key('j')), 'row-next');
  assert.equal(shortcutFor(key('j'), {typing: true}), null);
  assert.equal(shortcutFor({...key('j'), isComposing: true}), null);
  assert.equal(shortcutFor({...key('Enter'), keyCode: 229}), null);
  assert.equal(shortcutFor(key('j'), {dialogOpen: true}), null);
  assert.equal(shortcutFor(key('3', {ctrlKey: true}), {dialogOpen: true}), null);
  assert.equal(shortcutFor(key('/')), 'search');
  assert.equal(shortcutFor(key('?', {shiftKey: true})), 'help');
  assert.equal(shortcutFor(key('J', {shiftKey: true})), null);
});
test('modified combos still work inside fields', () => {
  assert.equal(shortcutFor(key('l', {ctrlKey: true}), {typing: true}), 'address');
});

function fixture() {
  const dom = new JSDOM(`<body>
    <button id="toolbar-back"></button><button id="toolbar-forward"></button>
    <button id="toolbar-sidebar"></button><input id="toolbar-search-input">
    <button id="desktop-compose"></button>
    <nav class="icon-rail"><button class="icon-nav-item" data-view="market"></button><button class="icon-nav-item" data-view="feed"></button><button class="icon-nav-item" data-view="ai"></button></nav>
    <section class="view on"><article class="post" tabindex="0" id="p1"><button class="post-action" aria-label="返信"></button><button class="post-action"></button><button class="post-action" aria-label="いいね"></button><button class="post-action" aria-label="ブックマーク"></button></article>
    <article class="post" tabindex="0" id="p2"></article><input type="search" id="q"></section></body>`, {pretendToBeVisual: true});
  const {window} = dom, {document} = window;
  for (const el of document.querySelectorAll('*')) el.getClientRects = () => [{width: 1, height: 1}];
  const clicks = [];
  document.addEventListener('click', (e) => clicks.push(e.target.id || e.target.dataset?.view || e.target.getAttribute('aria-label')), true);
  let view = 'feed';
  installShortcuts({document, getView: () => view});
  const press = (init, target = document.body) => {
    const event = new window.KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init});
    target.dispatchEvent(event);
    return event;
  };
  return {document, clicks, press, setView: (v) => { view = v; }};
}
test('Ctrl+n opens the nth rail screen', () => {
  const f = fixture();
  assert.equal(f.press({key: '1', ctrlKey: true}).defaultPrevented, true);
  assert.deepEqual(f.clicks, ['market']);
  f.press({key: '3', ctrlKey: true});
  assert.equal(f.clicks.at(-1), 'ai');
});
test('j and k move focus through rows; l, r, b, Enter act on the focused row', () => {
  const f = fixture();
  f.press({key: 'j'});
  assert.equal(f.document.activeElement.id, 'p1');
  f.press({key: 'j'});
  assert.equal(f.document.activeElement.id, 'p2');
  f.press({key: 'k'});
  f.press({key: 'l'});
  f.press({key: 'r'});
  f.press({key: 'b'});
  assert.deepEqual(f.clicks, ['いいね', '返信', 'ブックマーク']);
  const enter = f.press({key: 'Enter'}, f.document.activeElement);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(f.clicks.at(-1), 'p1');
});
test('keys typed in a field are left alone; "/" focuses the search field', () => {
  const f = fixture();
  const field = f.document.querySelector('#toolbar-search-input');
  field.focus();
  assert.equal(f.press({key: 'j'}, field).defaultPrevented, false);
  field.blur();
  f.press({key: '/'});
  assert.equal(f.document.activeElement.id, 'q');
});
test('Ctrl+\\ clicks the sidebar toggle and Alt+Left goes back', () => {
  const f = fixture();
  f.press({key: '\\', ctrlKey: true});
  f.press({key: 'ArrowLeft', altKey: true});
  assert.deepEqual(f.clicks, ['toolbar-sidebar', 'toolbar-back']);
});
test('? builds the shortcut list dialog', () => {
  const f = fixture();
  try { f.press({key: '?', shiftKey: true}); } catch { /* showModal is not implemented in jsdom */ }
  assert.ok(f.document.querySelector('#shortcuts-dialog'));
});
test('n clicks the left-column post button and leaves typing fields alone', () => {
  const f = fixture();
  assert.equal(f.press({key: 'n'}).defaultPrevented, true);
  assert.deepEqual(f.clicks, ['desktop-compose']);
  const field = f.document.querySelector('#toolbar-search-input');
  field.focus();
  assert.equal(f.press({key: 'n'}, field).defaultPrevented, false);
  assert.deepEqual(f.clicks, ['desktop-compose']);
});
