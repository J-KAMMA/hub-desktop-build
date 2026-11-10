import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { avatarTint, displayInitial, createState, skeletonList } from './state-view.mjs';
import { JSDOM } from 'jsdom';

// 2026-10-29: デスクトップは Web と形を共有し、色だけをテーマで選ぶ。
const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('font-weight literals are only 400, 500, 600, 700, 800 (macOS HIG 2026-11-05 allows 500 and 600)', () => {
  const bad = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    for (const m of strip(read(file)).matchAll(/font-weight\s*:\s*(\d+)\b/g)) {
      if (![400, 500, 600, 700, 800].includes(Number(m[1]))) bad.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('shape-tokens.css mirrors the Web shape tokens and carries no color', () => {
  const css = strip(read('shape-tokens.css'));
  assert.doesNotMatch(css, /[:\s(,]#[0-9a-f]{3,8}(?![\w-])|rgba?\(|hsla?\(/i);
  const want = {
    '--tap-height': '36px', '--tap-height-coarse': '44px',
    '--edge-fade': '24px', '--state-max': '400px', '--state-icon': '40px', '--state-icon-disc': '64px',
  };
  // 2026-11-05（macOS HIG、所有者承認）: デスクトップの焦点の輪は 3px・オフセット 1px。Web は 2px・2px のまま。
  assert.match(css, /--focus-ring-width:\s*3px;/);
  assert.match(css, /--focus-ring-offset:\s*1px;/);
  let web = null;
  try { web = read('../../hub/app/v2/v2-tokens.css'); } catch { /* the Web tree may be absent */ }
  for (const [name, value] of Object.entries(want)) {
    const re = new RegExp(`${name}:\\s*${value};`);
    assert.match(css, re, name);
    if (web) assert.match(web, re, `web ${name}`);
  }
});

test('type ramp sizes, leading and weights follow the unified design system (macOS HIG 2026-11-05: 11/14 · 12/16 · 13/18 · 15/20 · 16/28 · 17/22 · 22/28 · 26/32; 400 · 500 · 600 · 700)', () => {
  const tokens = strip(read('tokens.css'));
  const shape = strip(read('shape-tokens.css'));
  // 2026-11-06 所有者「視認性が低い、字が薄い」：本文・補足・注記の段を 1px ずつ上げた（13/18→14/20、12/16→13/18、11/14→12/16）。
  const ds = [['--ds-type-caption-size', '12px'], ['--ds-type-caption-leading', '16px'], ['--ds-type-meta-size', '13px'], ['--ds-type-meta-leading', '18px'],
    ['--ds-type-body-size', '14px'], ['--ds-type-body-leading', '20px'], ['--ds-type-title3-size', '15px'], ['--ds-type-title3-leading', '20px'],
    ['--ds-type-reading-size', '16px'], ['--ds-type-reading-leading', '28px'], ['--ds-type-title-size', '17px'], ['--ds-type-title-leading', '22px'],
    ['--ds-type-name-size', '22px'], ['--ds-type-name-leading', '28px'], ['--ds-type-article-size', '26px'], ['--ds-type-article-leading', '32px'],
    ['--ds-weight-text', '400'], ['--ds-weight-medium', '500'], ['--ds-weight-semibold', '600'], ['--ds-weight-strong', '600'], ['--ds-weight-heavy', '700']];
  for (const [name, value] of ds) assert.ok(tokens.includes(name + ': ' + value + ';'), name);
  const alias = [['--type-display', '--ds-type-article-size'], ['--type-title1', '--ds-type-name-size'], ['--type-title2', '--ds-type-title-size'],
    ['--type-title3', '--ds-type-title3-size'], ['--type-headline', '--ds-type-body-size'], ['--type-body', '--ds-type-body-size'],
    ['--type-callout', '--ds-type-meta-size'], ['--type-subhead', '--ds-type-meta-size'], ['--type-caption', '--ds-type-caption-size'],
    ['--type-footnote', '--ds-type-caption-size'], ['--lh-body', '--ds-type-body-leading'], ['--lh-subhead', '--ds-type-meta-leading'],
    ['--lh-caption', '--ds-type-caption-leading'], ['--lh-title2', '--ds-type-title-leading'], ['--lh-headline', '--ds-type-body-leading']];
  for (const [name, target] of alias) assert.ok(tokens.includes(name + ': var(' + target + ');'), name);
  assert.ok(shape.includes('--lh-callout: 20px;'));
  assert.ok(shape.includes('--type-title2-weight: var(--weight-bold)'));
  assert.ok(shape.includes('--type-callout-weight: var(--weight-bold)'));
});

test('spacing, radius and nav tokens are the unified scale and the retired text aliases are gone', () => {
  const tokens = strip(read('tokens.css'));
  const space = ['4px', '8px', '12px', '16px', '20px', '24px', '32px', '48px'];
  space.forEach((value, i) => assert.ok(tokens.includes('--ds-space-' + (i + 1) + ': ' + value + ';'), '--ds-space-' + (i + 1)));
  space.forEach((_, i) => assert.ok(tokens.includes('--space-' + (i + 1) + ': var(--ds-space-' + (i + 1) + ');'), '--space-' + (i + 1)));
  for (const [name, value] of [['card', '10px'], ['callout', '10px'], ['input', '6px'], ['tile-video', '10px'], ['tile-music', '8px'], ['badge', '4px'], ['sheet', '12px'], ['pill', '999px']]) {
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
