import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { avatarTint, displayInitial, createState, skeletonList } from './state-view.mjs';
import { JSDOM } from 'jsdom';

// 2026-10-29: デスクトップは Web と形を共有し、色だけをテーマで選ぶ。
const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('font-weight literals are only 400, 700, 800 (DESIGN-SYSTEM §2: never 500, 600 or 650)', () => {
  const bad = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    for (const m of strip(read(file)).matchAll(/font-weight\s*:\s*(\d+)\b/g)) {
      if (![400, 700, 800].includes(Number(m[1]))) bad.push(`${file}: ${m[1]}`);
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

test('type ramp sizes, leading and weights follow the unified design system (13/16 · 15/20 · 17/28 · 20/24 · 23/28 · 31/36; 400 · 700 · 800)', () => {
  const tokens = strip(read('tokens.css'));
  const shape = strip(read('shape-tokens.css'));
  const ds = [['--ds-type-meta-size', '13px'], ['--ds-type-meta-leading', '16px'], ['--ds-type-body-size', '15px'], ['--ds-type-body-leading', '20px'],
    ['--ds-type-reading-size', '17px'], ['--ds-type-reading-leading', '28px'], ['--ds-type-title-size', '20px'], ['--ds-type-title-leading', '24px'],
    ['--ds-type-name-size', '23px'], ['--ds-type-name-leading', '28px'], ['--ds-type-article-size', '31px'], ['--ds-type-article-leading', '36px'],
    ['--ds-weight-text', '400'], ['--ds-weight-strong', '700'], ['--ds-weight-heavy', '800']];
  for (const [name, value] of ds) assert.ok(tokens.includes(name + ': ' + value + ';'), name);
  const alias = [['--type-display', '--ds-type-article-size'], ['--type-title1', '--ds-type-name-size'], ['--type-title2', '--ds-type-title-size'],
    ['--type-title3', '--ds-type-title-size'], ['--type-headline', '--ds-type-reading-size'], ['--type-body', '--ds-type-body-size'],
    ['--type-callout', '--ds-type-body-size'], ['--type-subhead', '--ds-type-meta-size'], ['--type-caption', '--ds-type-meta-size'],
    ['--type-footnote', '--ds-type-meta-size'], ['--lh-body', '--ds-type-body-leading'], ['--lh-subhead', '--ds-type-meta-leading'],
    ['--lh-caption', '--ds-type-meta-leading'], ['--lh-title2', '--ds-type-title-leading'], ['--lh-headline', '--ds-type-reading-leading']];
  for (const [name, target] of alias) assert.ok(tokens.includes(name + ': var(' + target + ');'), name);
  assert.doesNotMatch(tokens, /--weight-(medium|semibold):/, 'no 500 or 600 weight tokens');
  assert.ok(shape.includes('--lh-callout: 20px;'));
  assert.ok(shape.includes('--type-title2-weight: var(--weight-bold)'));
  assert.ok(shape.includes('--type-callout-weight: var(--weight-bold)'));
});

test('spacing, radius and nav tokens are the unified scale and the retired text aliases are gone', () => {
  const tokens = strip(read('tokens.css'));
  const space = ['4px', '8px', '12px', '16px', '20px', '24px', '32px', '48px'];
  space.forEach((value, i) => assert.ok(tokens.includes('--ds-space-' + (i + 1) + ': ' + value + ';'), '--ds-space-' + (i + 1)));
  space.forEach((_, i) => assert.ok(tokens.includes('--space-' + (i + 1) + ': var(--ds-space-' + (i + 1) + ');'), '--space-' + (i + 1)));
  for (const [name, value] of [['card', '16px'], ['callout', '12px'], ['input', '8px'], ['tile-video', '12px'], ['tile-music', '8px'], ['badge', '4px'], ['pill', '999px']]) {
    assert.ok(tokens.includes('--ds-radius-' + name + ': ' + value + ';'), name);
  }
  const sources = readdirSync(dir).filter((f) => /\.(css|mjs|js)$/.test(f) && !f.endsWith('.test.mjs') && f !== 'tokens.css');
  for (const retired of ['--text-title', '--text-section', '--text-body', '--width-reading', '--width-collection']) {
    for (const file of sources) assert.ok(!read(file).includes('var(' + retired), file + ' still reads ' + retired);
  }
  for (const file of sources.filter((f) => f.endsWith('.css'))) {
    assert.doesNotMatch(strip(read(file)), /font-size\s*:\s*var\(--text-meta/, file + ': --text-meta is the gold text colour, not a size');
  }
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
