import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {attachAddressSelectAll} from './address-select-all.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

function setup() {
  const dom = new JSDOM('<input id="a" value="https://example.com/path"><button id="b"></button>');
  const {document, MouseEvent} = dom.window;
  const input = document.getElementById('a');
  attachAddressSelectAll(input);
  const mouse = (type, x = 5) => { const e = new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 0}); input.dispatchEvent(e); return e; };
  return {dom, document, input, mouse};
}
const all = (input) => input.selectionStart === 0 && input.selectionEnd === input.value.length;

test('focusing click selects everything and the mouseup does not deselect', () => {
  const {input, mouse} = setup();
  mouse('mousedown'); input.focus(); const up = mouse('mouseup');
  assert.ok(all(input)); assert.equal(up.defaultPrevented, true);
});

test('second click while focused is left alone for the caret', () => {
  const {input, mouse} = setup();
  mouse('mousedown'); input.focus(); mouse('mouseup');
  mouse('mousedown'); const up = mouse('mouseup');
  assert.equal(up.defaultPrevented, false);
  input.setSelectionRange(3, 3); assert.equal(input.selectionStart, 3);
});

test('dragging on the focusing click keeps the user selection', () => {
  const {input, mouse} = setup();
  mouse('mousedown', 5); input.focus(); const up = mouse('mouseup', 60);
  assert.equal(up.defaultPrevented, false);
});

test('keyboard focus selects everything, again after blur', () => {
  const {input, document} = setup();
  input.focus(); assert.ok(all(input));
  input.setSelectionRange(2, 2); document.getElementById('b').focus(); input.focus();
  assert.ok(all(input));
});

test('attach is idempotent and detach restores', () => {
  const dom = new JSDOM("<input id=a value=x>"); const input = dom.window.document.getElementById("a");
  const off = attachAddressSelectAll(input); const again = attachAddressSelectAll(input);
  again(); assert.equal(input.dataset.addressSelectAll, "1");
  off(); assert.equal(input.dataset.addressSelectAll, undefined);
});
