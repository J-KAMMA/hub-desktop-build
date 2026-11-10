import test from 'node:test';
import assert from 'node:assert/strict';
import { iconifyButton, TEXT_TO_ICON } from './text-button-icons.mjs';

const fake = (text, extra = {}) => {
  const attrs = new Map(); const classes = new Set(); let kids = [];
  const b = {
    localName: 'button', title: '', children: kids, textContent: text, ownerDocument: { createElementNS: () => ({ setAttribute() {}, append() {} }), createElement: () => ({ className: '', textContent: '' }) },
    closest: () => extra.kept ? {} : null, classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v), hasAttribute: (k) => attrs.has(k),
    replaceChildren(...n) { kids = n; b.children = kids; b.textContent = n.map(k => k.textContent ?? '').join(''); },
    classes,
  };
  return { b, attrs };
};

test('listed text becomes an icon and keeps its name in aria-label and title', () => {
  const { b, attrs } = fake('更新');
  assert.equal(iconifyButton(b), true);
  assert.equal(attrs.get('aria-label'), '更新'); assert.equal(b.title, '更新'); assert.equal(b.textContent, '');
});
test('follow toggles get aria-pressed', () => {
  const on = fake('フォロー中'); iconifyButton(on.b); assert.equal(on.attrs.get('aria-pressed'), 'true');
  const off = fake('フォロー'); iconifyButton(off.b); assert.equal(off.attrs.get('aria-pressed'), 'false');
});
test('purchase, payment, send, delete, consent and sign-in texts are never converted', () => {
  for (const text of ['購入する', '支払う', '送信', '投稿', '破棄', '削除', '同意する', 'ログアウト', 'Desktopを接続', '続きを表示']) {
    assert.equal(TEXT_TO_ICON.has(text), false, text);
    assert.equal(iconifyButton(fake(text).b), false, text);
  }
});
test('text inside a legal or consent container stays', () => {
  assert.equal(iconifyButton(fake('閉じる', { kept: true }).b), false);
});

test('tabs keep their text', () => {
  const { b, attrs } = fake('フォロー中'); attrs.set('role', 'tab');
  assert.equal(iconifyButton(b), false); assert.equal(b.textContent, 'フォロー中');
});

test('uncommon icons keep their name beside the icon; common ones are icon only', () => {
  const later = fake('あとで見る'); iconifyButton(later.b);
  assert.equal(later.b.textContent, 'あとで見る'); assert.ok(later.b.classes.has('is-text-icon-labeled'));
  const close = fake('閉じる'); iconifyButton(close.b);
  assert.equal(close.b.textContent, ''); assert.equal(close.b.classes.has('is-text-icon-labeled'), false);
});
