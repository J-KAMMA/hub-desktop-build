import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseDrafts, draftEditorPath, renderDraftList } from './article-drafts.mjs';

const doc = new JSDOM('').window.document;

test('形の合う下書きだけを通し、題が空なら仮の題にする', () => {
  const drafts = parseDrafts({ drafts: [
    { id: 'd1', title: '', summary: 's', status: 'scheduled', updatedAt: 'u' },
    { id: '../x', title: 'bad' }, { id: 5 }, null,
  ] });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].title, '（題未設定）');
  assert.equal(drafts[0].scheduled, true);
  assert.deepEqual(parseDrafts(null), []);
});

test('エディタのパスは識別子を検査してから作る', () => {
  assert.equal(draftEditorPath('abc-1_2'), '/v2/articles/new?draft=abc-1_2');
  for (const id of ['a/b', 'a?x', '', 5, 'a'.repeat(129)]) assert.throws(() => draftEditorPath(id));
});

test('一覧は題をtextContentで描き、押すとonOpenへ渡す', () => {
  const opened = [];
  const root = renderDraftList(doc, parseDrafts({ drafts: [{ id: 'd1', title: '<img src=x onerror=alert(1)>', summary: '', status: 'draft', updatedAt: 'u' }] }), { relTime: () => '1分前', onOpen: (d) => opened.push(d.id) });
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('.article-draft-title').textContent, '<img src=x onerror=alert(1)>');
  assert.match(root.textContent, /下書き · 1分前/);
  root.querySelector('button').click();
  assert.deepEqual(opened, ['d1']);
  assert.match(renderDraftList(doc, [], { onOpen() {} }).textContent, /下書きはまだありません/);
});

test('見出しの「下書き」は画面の題に任せ、一覧では件数だけを出す', () => {
  const full = renderDraftList(doc, parseDrafts({ drafts: [{ id: 'd1', title: 't', status: 'draft', updatedAt: 'u' }] }), { onOpen() {} });
  assert.equal(full.querySelector('.result-heading').textContent, '1件');
  assert.equal(renderDraftList(doc, [], { onOpen() {} }).querySelector('.result-heading'), null);
});
