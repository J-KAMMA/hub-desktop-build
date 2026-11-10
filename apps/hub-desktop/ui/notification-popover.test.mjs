import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createNotificationPopover, POPOVER_LIMIT} from './notification-popover.mjs';

function setup() {
  const {window} = new JSDOM('<button id="a" aria-label="通知"></button><button id="outside"></button>', {pretendToBeVisual: true});
  const {document} = window;
  const calls = [];
  const anchor = document.querySelector('#a');
  const pop = createNotificationPopover({document, anchor, onOpenItem: (ref) => calls.push(['open', ref]), onAll: () => calls.push(['all'])});
  const items = Array.from({length: 8}, (_, i) => ({title: `人${i}`, text: `本文${i}`, unread: i === 0, time: '1分前', ref: `g${i}`}));
  return {window, document, anchor, pop, calls, items};
}

test('opens next to the icon, lists at most five rows and a final 「すべて見る」 row', () => {
  const {document, pop, anchor, items} = setup();
  pop.open();
  pop.render({state: 'ready', items});
  assert.equal(pop.isOpen(), true);
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  assert.equal(pop.root.hidden, false);
  assert.equal(pop.root.querySelectorAll('.notif-pop-row').length, POPOVER_LIMIT);
  assert.equal(POPOVER_LIMIT, 5);
  const last = pop.root.lastElementChild;
  assert.equal(last.textContent, 'すべて見る');
  assert.ok(pop.root.querySelector('.notif-pop-row.unread'));
  assert.equal(document.body.contains(pop.root), true);
});

test('Esc closes it and gives focus back to the icon', () => {
  const {window, document, pop, anchor} = setup();
  pop.open();
  pop.render({state: 'loading'});
  document.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  assert.equal(pop.isOpen(), false);
  assert.equal(pop.root.hidden, true);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, anchor);
});

test('a press outside closes it; a press inside does not', () => {
  const {window, document, pop, items} = setup();
  pop.open();
  pop.render({state: 'ready', items});
  pop.root.dispatchEvent(new window.Event('pointerdown', {bubbles: true}));
  assert.equal(pop.isOpen(), true);
  document.querySelector('#outside').dispatchEvent(new window.Event('pointerdown', {bubbles: true}));
  assert.equal(pop.isOpen(), false);
});

test('a row opens that notification and stays logically open until the open (and its mark-as-read) finishes; 「すべて見る」 goes to the full view', async () => {
  const {pop, calls, items} = setup();
  pop.open();
  pop.render({state: 'ready', items});
  pop.root.querySelectorAll('.notif-pop-row')[1].click();
  assert.equal(pop.root.hidden, true);
  assert.equal(pop.isOpen(), true, 'the read mark needs the popover context while the open runs');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['open', 'g1']]);
  assert.equal(pop.isOpen(), false);
  pop.open();
  pop.render({state: 'ready', items});
  pop.root.querySelector('.notif-pop-all').click();
  assert.deepEqual(calls.at(-1), ['all']);
  assert.equal(pop.isOpen(), false);
});

test('empty, loading and error states still end with 「すべて見る」', () => {
  const {pop} = setup();
  pop.open();
  for (const model of [{state: 'ready', items: []}, {state: 'loading'}, {state: 'error'}, {state: 'signedout', message: '接続してください'}]) {
    pop.render(model);
    assert.equal(pop.root.querySelectorAll('.notif-pop-row').length, 0);
    assert.equal(pop.root.lastElementChild.textContent, 'すべて見る');
  }
});

test('app.js wiring: only a real press opens the popover; code-driven clicks still navigate; the rail starts with the new order', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(app, /if \(!event\.isTrusted\) return;\s*event\.stopImmediatePropagation\(\);/);
  assert.match(app, /createNotificationPopover\(\{/);
  assert.match(html, /href="\.\/notification-popover\.css"/);
  const rail = html.match(/<nav class="icon-rail"[\s\S]*?<\/nav>/)[0];
  const order = [...rail.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]).slice(0, 5);
  assert.deepEqual(order, ['feed', 'notifications', 'messages', 'videos', 'music']);
});
