import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LOCALE_KEY, createTranslator, installI18n, createLanguageSetting, loadLocale, normalizeLocale } from './i18n.mjs';
import * as en from './locales/en.mjs';

const memory = () => { const map = new Map(); return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); } }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const DICT = { en: { exact: { '設定': 'Settings', '通知': 'Notifications', '再試行': 'Retry', '検索': 'Search', '言語': 'Language' }, patterns: [[/^返信 (\d+)件$/, '$1 replies']] } };
const page = (html, storage = memory(), locale) => {
  const dom = new JSDOM(`<body>${html}</body>`, { pretendToBeVisual: true });
  const i18n = installI18n({ document: dom.window.document, storage, dictionaries: DICT, ...(locale ? { locale } : {}) });
  return { dom, document: dom.window.document, i18n, storage };
};

test('the locale defaults to Japanese, survives broken storage and unknown values', () => {
  assert.equal(normalizeLocale('fr'), 'ja');
  assert.equal(loadLocale(null), 'ja');
  assert.equal(loadLocale({ getItem() { throw new Error('blocked'); } }), 'ja');
  const s = memory(); s.setItem(LOCALE_KEY, 'en');
  assert.equal(loadLocale(s), 'en');
});

test('a translator replaces exact UI strings and number patterns, keeps surrounding space, and leaves everything else', () => {
  const t = createTranslator(DICT.en);
  assert.equal(t('設定'), 'Settings');
  assert.equal(t('  設定\n'), '  Settings\n');
  assert.equal(t('返信 12件'), '12 replies');
  assert.equal(t('設定を開く'), null, 'no partial replacement');
  assert.equal(t('Settings'), null);
  assert.equal(t(''), null);
});

test('Japanese is the source: with locale ja nothing is touched', () => {
  const f = page('<button title="設定">設定</button>');
  assert.equal(f.document.querySelector('button').textContent, '設定');
  assert.equal(f.document.documentElement.lang, 'ja');
  f.dom.window.close();
});

test('English replaces text, title, aria-label and placeholder, also for nodes added or changed later', async () => {
  const f = page('<button title="設定" aria-label="通知">設定</button><input placeholder="検索">', memory(), 'en');
  const button = f.document.querySelector('button');
  assert.deepEqual([button.textContent, button.title, button.getAttribute('aria-label'), f.document.querySelector('input').placeholder], ['Settings', 'Settings', 'Notifications', 'Search']);
  assert.equal(f.document.documentElement.lang, 'en');
  const later = f.document.createElement('p'); later.textContent = '返信 3件'; f.document.body.append(later);
  button.textContent = '再試行'; button.setAttribute('aria-label', '検索');
  await tick();
  assert.deepEqual([later.textContent, button.textContent, button.getAttribute('aria-label')], ['3 replies', 'Retry', 'Search']);
  f.dom.window.close();
});

test('what people wrote is never translated, even when it equals a UI string', async () => {
  const f = page('<article><p class="post-body">設定</p><h3 class="thread-row-title">通知</h3><textarea>設定</textarea><span translate="no">設定</span></article><button>設定</button>', memory(), 'en');
  assert.deepEqual([...f.document.querySelectorAll('.post-body, .thread-row-title, [translate=no]')].map((n) => n.textContent), ['設定', '通知', '設定']);
  assert.equal(f.document.querySelector('textarea').value, '設定');
  assert.equal(f.document.querySelector('button').textContent, 'Settings');
  f.dom.window.close();
});

test('switching back restores the Japanese, saves the choice, and source() always answers in Japanese', async () => {
  const f = page('<button title="設定">設定</button>', memory(), 'en');
  const button = f.document.querySelector('button');
  assert.equal(f.i18n.source(button), '設定');
  assert.equal(f.i18n.sourceAttr(button, 'title'), '設定');
  f.i18n.setLocale('ja');
  assert.deepEqual([button.textContent, button.title, f.document.documentElement.lang], ['設定', '設定', 'ja']);
  assert.equal(f.storage.map.get(LOCALE_KEY), 'ja');
  f.i18n.setLocale('en');
  assert.equal(button.textContent, 'Settings');
  assert.equal(f.storage.map.get(LOCALE_KEY), 'en');
  f.dom.window.close();
});

test('untranslated Japanese is collected so the dictionary can grow', () => {
  const f = page('<p>未訳の文言</p><p>設定</p>', memory(), 'en');
  assert.deepEqual(f.i18n.missing(), ['未訳の文言']);
  f.dom.window.close();
});

test('the language row switches at once and keeps the language names as they are', async () => {
  const f = page('<main></main>');
  const row = createLanguageSetting({ document: f.document, i18n: f.i18n });
  f.document.querySelector('main').append(row);
  assert.deepEqual([...row.querySelectorAll('[role=radio]')].map((b) => [b.textContent, b.getAttribute('aria-checked')]), [['日本語', 'true'], ['English', 'false']]);
  row.querySelector('[data-locale="en"]').click();
  await tick();
  assert.equal(row.querySelector('.setting-label').textContent, 'Language');
  assert.deepEqual([...row.querySelectorAll('[role=radio]')].map((b) => [b.textContent, b.getAttribute('aria-checked')]), [['日本語', 'false'], ['English', 'true']]);
  f.dom.window.close();
});

test('the English dictionary: every key is Japanese, every value is not, and patterns keep their numbers', () => {
  const japanese = /[぀-ヿ㐀-鿿]/;
  const entries = Object.entries(en.EXACT);
  assert.ok(entries.length > 200);
  for (const [key, value] of entries) {
    assert.ok(japanese.test(key), `key is Japanese: ${key}`);
    assert.equal(typeof value, 'string');
    // 利用者にそのまま打ってもらう言葉（確認の入力）だけは、訳の中に日本語のまま残す。
    const typed = ['ウォレットを消す'].reduce((text, phrase) => text.replaceAll(phrase, ''), value);
    assert.ok(value.trim().length > 0 && !japanese.test(typed), `value is translated: ${key} -> ${value}`);
    assert.equal(key, key.trim());
  }
  const t = createTranslator({ exact: en.EXACT, patterns: en.PATTERNS });
  assert.equal(t('3日前'), '3d ago');
  assert.equal(t('5時間前'), '5h ago');
  assert.equal(t('2か月前'), '2mo ago');
});
