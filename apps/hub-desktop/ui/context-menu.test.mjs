import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {defaultItems, installContextMenu, httpUrl} from './context-menu.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

const labels = (items) => items.filter((i) => i !== '-').map((i) => i.label);

test('links: Hub URLs only offer the default browser and copy', () => {
  const dom = new JSDOM('<a id="a" href="https://hub.jkamma.com/x">x</a><a id="b" href="https://example.com/">y</a><a id="c" href="#top">z</a><a id="d" href="javascript:alert(1)">w</a>');
  const {document} = dom.window;
  const isHubUrl = (url) => url.host === 'hub.jkamma.com';
  assert.deepEqual(labels(defaultItems(document.querySelector('#a'), {isHubUrl})), ['既定のブラウザで開く', 'リンクのアドレスをコピー']);
  assert.deepEqual(labels(defaultItems(document.querySelector('#b'), {isHubUrl})), ['新しいタブで開く', '既定のブラウザで開く', 'リンクのアドレスをコピー']);
  assert.equal(defaultItems(document.querySelector('#d'), {isHubUrl}).length, 0);
  assert.equal(httpUrl('javascript:alert(1)'), null);
});
test('images and fields get their own items', () => {
  const dom = new JSDOM('<img id="i" src="https://cdn.example.com/a.png"><input id="f" value="abc"><p id="p">t</p>');
  const {document} = dom.window;
  assert.deepEqual(labels(defaultItems(document.querySelector('#i'), {})), ['画像を新しいタブで開く', '画像のアドレスをコピー']);
  assert.deepEqual(labels(defaultItems(document.querySelector('#f'), {})), ['切り取り', 'コピー', '貼り付け', 'すべて選択']);
  assert.deepEqual(labels(defaultItems(document.querySelector('#p'), {selection: 'text'})), ['コピー']);
  assert.equal(defaultItems(document.querySelector('#p'), {selection: ''}).length, 0);
});
test('the menu suppresses the native one, navigates by keyboard, and closes on Escape', () => {
  const dom = new JSDOM('<body><a id="b" href="https://example.com/">y</a><p id="p">t</p></body>', {pretendToBeVisual: true});
  const {document, window} = dom.window;
  const opened = [];
  const menu = installContextMenu({document, window, isHubUrl: () => false, openTab: (u) => opened.push(['tab', u]), openExternal: (u) => opened.push(['ext', u])});
  const fire = (target) => { const e = new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 10, clientY: 10}); target.dispatchEvent(e); return e; };
  assert.equal(fire(document.querySelector('#p')).defaultPrevented, true);
  assert.equal(menu.isOpen(), false);
  fire(document.querySelector('#b'));
  assert.equal(menu.isOpen(), true);
  const root = document.querySelector('.context-menu');
  assert.equal(root.getAttribute('role'), 'menu');
  root.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
  assert.equal(document.activeElement.textContent, '新しいタブで開く');
  document.activeElement.click();
  assert.deepEqual(opened, [['tab', 'https://example.com/']]);
  assert.equal(menu.isOpen(), false);
  fire(document.querySelector('#b'));
  document.querySelector('.context-menu').dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  assert.equal(menu.isOpen(), false);
});
test('registered providers take precedence', () => {
  const dom = new JSDOM('<body><div id="x" class="special">x</div></body>');
  const {document, window} = dom.window;
  const menu = installContextMenu({document, window});
  menu.register((target) => target?.closest('.special') ? [{label: '開く', run() {}}] : null);
  document.querySelector('#x').dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 5, clientY: 5}));
  assert.equal(document.querySelector('.ds-menu-item').textContent, '開く');
});
