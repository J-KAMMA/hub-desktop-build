import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { articleEmptyCopy, articleRowModel, pickFeatured, renderArticleEmpty, renderArticleHome, renderArticleRow } from './article-rows.mjs';

const css = readFileSync(new URL('./article-home.css', import.meta.url), 'utf8');
const items = [
  { id: 'a1', title: '一つ目', summary: '要約', authorName: '蒼井', createdAt: 'x', tags: ['Hub'] },
  { id: 'a2', title: '二つ目', thumbnailUrl: '/api/thumb/2.png', authorName: 'Mio', tags: [] },
  { id: 'a3', title: '三つ目', thumbnailUrl: 'https://evil.example/x.png' },
];
const dom = () => new JSDOM('<main id="m"></main>', { url: 'http://localhost' }).window.document;
const options = { hubAsset: (img, url) => { img.src = url; }, relTime: () => '3日前' };

test('the featured row is the first article with a thumbnail, else the first', () => {
  assert.equal(pickFeatured(items), 1);
  assert.equal(pickFeatured([{ id: 'x' }, { id: 'y' }]), 0);
  assert.equal(pickFeatured([]), -1);
  const root = renderArticleHome(dom(), items, options);
  const rows = [...root.children];
  assert.deepEqual(rows.map(row => row.dataset.articleId), ['a2', 'a1', 'a3']);
  assert.deepEqual(rows.map(row => row.classList.contains('ar-featured')), [true, false, false]);
});

test('no articles: no list (the caller shows an empty state)', () => {
  assert.equal(renderArticleHome(dom(), [], options), null);
  assert.equal(renderArticleHome(dom(), undefined, options), null);
});

test('a row has title, summary, meta and a thumbnail as the last child (right side); no card classes', () => {
  const row = renderArticleRow(dom(), items[0], options);
  assert.equal(row.querySelector('.ar-title').textContent, '一つ目');
  assert.equal(row.querySelector('.ar-summary').textContent, '要約');
  assert.equal(row.querySelector('.ar-meta').textContent, '蒼井 · 3日前 · #Hub');
  assert.ok(row.lastElementChild.classList.contains('ar-thumb'));
  assert.ok(!row.classList.contains('card') && !row.classList.contains('result-card'));
  assert.equal(row.getAttribute('role'), 'listitem');
});

test('thumbnails: allowed images load, others fall back to a lettered cover with no broken image', () => {
  const [allowed, blocked, none] = [items[1], items[2], items[0]].map(item => renderArticleRow(dom(), item, options));
  assert.equal(allowed.querySelector('.ar-thumb img').getAttribute('src'), '/api/thumb/2.png');
  assert.equal(blocked.querySelector('img'), null);
  assert.equal(blocked.querySelector('.ds-cover-label').textContent, '三');
  assert.equal(none.querySelector('.ds-cover-label').textContent, 'Hub', 'the first tag labels a cover');
});

test('only a row with an id opens; Enter and Space open it', () => {
  const doc = dom();
  const opened = [];
  const row = renderArticleRow(doc, items[0], { ...options, onOpen: item => opened.push(item.id) });
  row.click();
  row.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  row.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.deepEqual(opened, ['a1', 'a1', 'a1']);
  const idless = renderArticleRow(doc, { title: 'x' }, { ...options, onOpen: item => opened.push(item) });
  idless.click();
  assert.equal(opened.length, 3);
  assert.equal(idless.tabIndex, -1);
});

test('row model tolerates missing fields', () => {
  const view = articleRowModel({}, {});
  assert.equal(view.title, '（題未設定）');
  assert.equal(view.id, '');
  assert.equal(view.when, '');
});

test('empty states: title, body and at most one secondary button; no icon disc', () => {
  const doc = dom();
  for (const kind of ['none', 'filtered', 'drafts', 'saved', 'tag']) {
    const box = renderArticleEmpty(doc, kind, { actions: { write: () => {}, clear: () => {}, home: () => {} } });
    assert.equal(box.getAttribute('role'), 'status');
    assert.ok(box.querySelector('.ar-empty-title').textContent.length > 0);
    assert.ok(box.querySelector('.ar-empty-body').textContent.length > 0);
    assert.ok(box.querySelectorAll('button').length <= 1, kind);
    assert.equal(box.querySelector('svg, .empty-icon, .state-icon'), null);
    for (const button of box.querySelectorAll('button')) assert.ok(button.classList.contains('btn-secondary'));
  }
});

test('empty-state actions are wired and absent when the caller gives none', () => {
  const doc = dom();
  const ran = [];
  renderArticleEmpty(doc, 'filtered', { actions: { clear: () => ran.push('clear') } }).querySelector('button').click();
  assert.deepEqual(ran, ['clear']);
  assert.equal(renderArticleEmpty(doc, 'none').querySelector('button'), null);
  assert.equal(articleEmptyCopy('saved', { actions: { write: () => {} } }).action, null);
  assert.equal(articleEmptyCopy('unknown').title, '記事はまだありません');
});

test('css: 120x80 thumbnail, 20/800 empty title, 36px button, tokens only', () => {
  assert.match(css, /\.ar-row > \.ar-thumb \{[^}]*width: 120px; height: 80px/);
  assert.match(css, /\.ar-empty-title \{[^}]*var\(--type-title2\)[^}]*var\(--weight-heavy\)/);
  assert.match(css, /\.ar-empty-action \{[^}]*height: var\(--ds-btn-h\)/);
  assert.match(css, /\.ar-empty-body \{[^}]*max-width: 360px/);
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|(?<![-\w])(?:white|black)(?![-\w])/);
  assert.doesNotMatch(code, /(?:font-size|border-radius)\s*:\s*\d+px/);
  assert.doesNotMatch(code, /--emphasis/, 'gold is not a fill here');
});
