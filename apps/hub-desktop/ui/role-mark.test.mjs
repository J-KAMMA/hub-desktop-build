import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roleView, roleMark } from './role-mark.mjs';
import { createPostRow } from './post-row.mjs';

const el = (tag) => ({ tag, children: [], attrs: {}, className: '', textContent: '', title: '', innerHTML: '', classList: { add() {}, remove() {} }, dataset: {},
  append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, querySelector() { return null; } });
const doc = { createElement: el };
const walk = (node, out = []) => { out.push(node); for (const child of node.children ?? []) if (typeof child === 'object') walk(child, out); return out; };
const marks = (row) => walk(row).filter((n) => String(n.className).includes('role-mark'));

test('only the exact roles owner and moderator produce a mark', () => {
  assert.equal(roleView('owner').label, '運営');
  assert.equal(roleView('moderator').label, 'モデレーター');
  for (const bad of [undefined, null, '', 'member', 'Owner', 'admin', '運営', '✓', 'owner ', {}, ['owner'], 1, '__proto__', 'toString', 'constructor']) assert.equal(roleView(bad), null, String(bad));
});

test('the mark is a line icon with an aria-label and tooltip, no fill', () => {
  const node = roleMark(doc, 'moderator');
  assert.equal(node.attrs['aria-label'], 'モデレーター');
  assert.match(node.title, /モデレーター/);
  assert.match(node.innerHTML, /fill="none"/);
  assert.equal(roleMark(doc, 'member'), null);
});

const base = { time: '', icon: () => '<svg/>', body: 'x' };

test('a name containing 「✓」「運営」 gets no mark; the role field alone decides', () => {
  const fake = createPostRow(doc, { ...base, authorName: '✓ 運営 公式 official admin moderator サポート', authorHandle: 'official', authorRole: undefined });
  assert.equal(marks(fake).length, 0);
  const memberLike = createPostRow(doc, { ...base, authorName: '運営', authorRole: 'member' });
  assert.equal(marks(memberLike).length, 0);
  const real = createPostRow(doc, { ...base, authorName: 'ふつうの名前', authorRole: 'owner' });
  assert.equal(marks(real).length, 1);
  assert.equal(marks(real)[0].attrs['aria-label'], '運営');
});

test('the mark text never comes from user text', () => {
  const real = createPostRow(doc, { ...base, authorName: '偽モデレーター', authorRole: 'moderator' });
  assert.equal(marks(real)[0].attrs['aria-label'], 'モデレーター');
  assert.ok(!marks(real)[0].innerHTML.includes('偽'));
});

test('role-mark css uses semantic tokens only and no fill', () => {
  const css = readFileSync(new URL('./unified-post.css', import.meta.url), 'utf8');
  const rule = css.split('\n').filter((l) => l.includes('.role-mark')).join('\n');
  assert.ok(rule.length > 0);
  assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b|rgb|hsl|background/i);
});

import { publicChatMessages } from './rail-chat.mjs';
test('chat rows take the role only from the server profile field, never from the name', () => {
  const rows = publicChatMessages({
    profiles: { a: { displayName: '運営✓', communityRole: undefined }, b: { displayName: 'b', communityRole: 'moderator' } },
    messages: [{ id: 'm1', authorProfileId: 'a', body: 'x', createdAt: '2026-01-01T00:00:00Z' }, { id: 'm2', authorProfileId: 'b', body: 'y', createdAt: '2026-01-02T00:00:00Z' }],
  });
  assert.equal(rows[0].role, null);
  assert.equal(rows[1].role, 'moderator');
});
