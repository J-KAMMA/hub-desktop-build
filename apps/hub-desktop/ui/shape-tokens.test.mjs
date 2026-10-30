import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { avatarTint, displayInitial, createState, skeletonList } from './state-view.mjs';
import { JSDOM } from 'jsdom';

// 2026-10-29: デスクトップは Web と形を共有し、色だけをテーマで選ぶ。
const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('font-weight literals are only 400, 500, 600, 700', () => {
  const bad = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    for (const m of strip(read(file)).matchAll(/font-weight\s*:\s*(\d+)\b/g)) {
      if (![400, 500, 600, 700].includes(Number(m[1]))) bad.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('shape-tokens.css mirrors the Web shape tokens and carries no color', () => {
  const css = strip(read('shape-tokens.css'));
  assert.doesNotMatch(css, /[:\s(,]#[0-9a-f]{3,8}(?![\w-])|rgba?\(|hsla?\(/i);
  const want = {
    '--tap-height': '36px', '--tap-height-coarse': '44px', '--focus-ring-width': '2px', '--focus-ring-offset': '2px',
    '--edge-fade': '24px', '--state-max': '400px', '--state-icon': '40px', '--state-icon-disc': '64px',
  };
  let web = null;
  try { web = read('../../hub/app/v2/v2-tokens.css'); } catch { /* the Web tree may be absent */ }
  for (const [name, value] of Object.entries(want)) {
    const re = new RegExp(`${name}:\\s*${value};`);
    assert.match(css, re, name);
    if (web) assert.match(web, re, `web ${name}`);
  }
});

test('type ramp sizes, leading and weights match the Web table', () => {
  const tokens = strip(read('tokens.css'));
  const shape = strip(read('shape-tokens.css'));
  const pairs = [['--type-title2', '22px'], ['--type-title3', '20px'], ['--type-headline', '17px'], ['--type-body', '15px'],
    ['--type-callout', '15px'], ['--type-subhead', '13px'], ['--type-caption', '12px'], ['--lh-title2', '28px'],
    ['--lh-title3', '26px'], ['--lh-headline', '24px'], ['--lh-body', '24px'], ['--lh-subhead', '18px'], ['--lh-caption', '16px']];
  for (const [name, value] of pairs) assert.match(tokens, new RegExp(`${name}:\\s*${value};`), name);
  assert.match(shape, /--lh-callout:\s*20px;/);
  assert.match(shape, /--type-title2-weight:\s*var\(--weight-bold\)/);
  assert.match(shape, /--type-callout-weight:\s*var\(--weight-semibold\)/);
});

test('avatar tint and initial follow the Web rules', () => {
  assert.equal(avatarTint('A'), ((65 % 6) + 1));
  assert.equal(avatarTint('ab'), (((97 * 31 + 98) % 6) + 1));
  assert.equal(avatarTint(''), 1);
  assert.equal(avatarTint('写真散歩の会'), avatarTint(' 写真散歩の会 '));
  for (const n of ['x', 'Hub', '見本', 'zzzzzzzzzzzzzzzzzzzzzzzz']) assert.ok(avatarTint(n) >= 1 && avatarTint(n) <= 6);
  assert.equal(displayInitial('【見本】写真散歩の会'), '写');
  assert.equal(displayInitial('[WIP] hub'), 'H');
  assert.equal(displayInitial('【見本】'), '見');
  assert.equal(displayInitial('', '?'), '?');
});

test('avatar colors come from semantic variables in both themes', () => {
  const tokens = strip(read('tokens.css'));
  for (let i = 1; i <= 6; i += 1) assert.equal(tokens.split(`--avatar-${i}:`).length - 1, 2, `--avatar-${i} in light and dark`);
  const components = strip(read('components.css'));
  assert.doesNotMatch(components, /[:\s(,]#[0-9a-f]{3,8}(?![\w-])|rgba?\(|hsla?\(/i);
});

test('createState builds empty / signedOut / error / loading', () => {
  const { document } = new JSDOM('').window;
  const svg = (name) => `<svg data-i="${name}"></svg>`;
  const error = createState(document, { kind: 'error', note: '接続を確認してください。', action: { label: '再試行', onClick() {} }, iconSvg: svg });
  assert.equal(error.getAttribute('role'), 'alert');
  assert.ok(error.classList.contains('ds-state--error') && error.classList.contains('state-panel'));
  assert.equal(error.querySelector('.state-title').textContent, '読み込めませんでした');
  assert.equal(error.querySelector('.state-icon svg').dataset.i, 'alert');
  assert.equal(error.querySelectorAll('.btn-primary').length, 1);
  const out = createState(document, { kind: 'signedOut', action: { label: 'ログイン', onClick() {} }, secondaryAction: { label: 'あとで', onClick() {} } });
  assert.equal(out.querySelector('.state-title').textContent, 'ログインが必要です');
  assert.equal(out.querySelectorAll('.btn-primary').length, 1);
  assert.equal(out.querySelectorAll('.btn-ghost').length, 1);
  const empty = createState(document, { kind: 'empty', title: 'まだありません', compact: true });
  assert.ok(empty.classList.contains('is-compact'));
  assert.equal(empty.querySelectorAll('button').length, 0);
  const loading = createState(document, { kind: 'loading', rows: 3 });
  assert.equal(loading.querySelectorAll('.ds-skel-row').length, 3);
  assert.equal(loading.querySelector('[role="status"]').getAttribute('aria-busy'), 'true');
  assert.equal(skeletonList(document, 99).querySelectorAll('.ds-skel-row').length, 12);
});

test('state and skeleton rules sit in components.css, wired to the index', () => {
  assert.match(read('index.html'), /shape-tokens\.css/);
  const css = strip(read('components.css'));
  assert.match(css, /max-width:\s*var\(--state-max\)/);
  assert.match(css, /width:\s*var\(--state-icon-disc\)/);
  assert.match(css, /border-radius:\s*var\(--radius-pill\)/);
  assert.match(css, /min-height:\s*var\(--tap-height\)/);
  assert.match(css, /--edge-fade/);
});
