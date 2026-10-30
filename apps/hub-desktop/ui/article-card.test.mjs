import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createCoverMedia} from './media-image.mjs';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('function articleCoverLabel(');
const end = source.indexOf('// 連絡先', start);
assert.ok(start >= 0 && end > start, 'article card renderer is present in app.js');

function runtime(document, hubAsset = () => {}) {
  return new Function('document', 'createCoverMedia', 'hubAsset', 'hubOrigin', 'openHubPath',
    `${source.slice(start, end)}; return {articleCoverLabel, catalogCard};`)(
    document, createCoverMedia, hubAsset, '', () => {});
}

function cardFor(document, article, hubAsset) {
  const {articleCoverLabel, catalogCard} = runtime(document, hubAsset);
  return catalogCard({
    cover: true,
    coverLabel: articleCoverLabel(article),
    title: article.title,
    body: article.summary,
    imageUrl: article.thumbnailUrl,
    meta: ['作者の記事', article.authorName, '2026-10-01'],
    onOpen: () => {},
  });
}

test('an article without a cover uses a generated label cover and renders the title once', () => {
  const {document} = new JSDOM('<main></main>').window;
  const article = {title: '静かな読書', summary: '要約', tags: ['読書'], authorName: '山田'};
  const card = cardFor(document, article);
  assert.equal(card.querySelectorAll('img').length, 0);
  assert.equal(card.classList.contains('has-cover'), true);
  assert.equal(card.querySelector('.ds-media').style.getPropertyValue('--ratio'), '16 / 9');
  assert.equal(card.querySelector('.ds-cover-generated .ds-cover-label').textContent, '読書');
  assert.equal([...card.textContent.matchAll(/静かな読書/g)].length, 1);
  assert.equal(card.querySelector('strong').textContent, '静かな読書');
});

test('an article without a tag labels the cover with the first title character, not the title', () => {
  const {document} = new JSDOM('<main></main>').window;
  const {articleCoverLabel} = runtime(document);
  assert.equal(articleCoverLabel({title: '静かな読書', tags: []}), '静');
  assert.equal(articleCoverLabel({title: '  ', tags: ['', '  ']}), '記事');
  const card = cardFor(document, {title: '静かな読書', summary: '要約', tags: []});
  assert.equal(card.querySelector('.ds-cover-label').textContent, '静');
  assert.equal([...card.textContent.matchAll(/静かな読書/g)].length, 1);
});

test('an article with a cover image renders the image instead of a generated cover', () => {
  const {document} = new JSDOM('<main></main>').window;
  const seen = [];
  const hubAsset = (img, url) => { img.dataset.src = url; seen.push(url); };
  const card = cardFor(document, {title: '写真の記事', summary: '要約', tags: ['写真'], thumbnailUrl: '/cover.jpg'}, hubAsset);
  const img = card.querySelector('img');
  assert.ok(img);
  assert.equal(img.dataset.src, '/cover.jpg');
  assert.deepEqual(seen, ['/cover.jpg']);
  assert.equal(card.querySelector('.ds-cover-generated'), null);
  assert.equal(card.querySelector('.ds-media').style.getPropertyValue('--ratio'), '16 / 9');
});

test('a broken cover image falls back to the generated label without repeating the title', () => {
  const {document} = new JSDOM('<main></main>').window;
  const card = cardFor(document, {title: '消えた表紙', summary: '要約', tags: ['記録'], thumbnailUrl: '/gone.jpg'}, () => {});
  card.querySelector('img').onerror();
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.querySelector('.ds-cover-generated .ds-cover-label').textContent, '記録');
  assert.equal([...card.textContent.matchAll(/消えた表紙/g)].length, 1);
});
