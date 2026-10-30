// 標準（明）と金（暗）の主要な色が、Web の apps/hub/app/color-system.css と同じ値であること。
// どちらかを変えたら、もう一方も同じ値に揃える（2026-10-29 旦那様の決定）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const desktop = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const web = readFileSync(new URL('../../hub/app/color-system.css', import.meta.url), 'utf8');

function block(css, selectorRe) {
  const m = css.split('\r').join('').match(new RegExp(`${selectorRe.replace(/[[\]]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `block not found: ${selectorRe}`);
  return Object.fromEntries(Array.from(m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g), (x) => [x[1], x[2].toLowerCase()]));
}
const lum = (hex) => {
  const [r, g, b] = hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const LIGHT = ['bg', 'panel', 'surface-raised', 'surface-sunken', 'content-surface', 'content-nested', 'text', 'action-text', 'positive-bg', 'positive-text', 'warning-bg', 'warning-text', 'danger-bg', 'danger-text'];
const GOLD = ['bg', 'panel', 'surface-raised', 'surface-sunken', 'content-surface', 'content-nested', 'interactive', 'interactive-hover', 'selected', 'selected-text', 'line', 'line-strong', 'text', 'muted', 'text-meta', 'action-text', 'chip-bg', 'chip-text', 'chip-selected-bg', 'chip-selected-text'];

test('標準（明）: デスクトップのライトは Web のライトと主要な色が同じ', () => {
  const d = block(desktop, 'html\[data-theme="light"\]');
  const w = block(web, 'html\[data-theme="light"\]');
  for (const k of LIGHT) assert.equal(d[k], w[k], `light --${k}`);
  assert.equal(d['accent-base'], w.action, 'light action');
});

for (const theme of ['dark', 'light']) {
  test(`金（${theme === 'dark' ? '暗' : '明'}）: デスクトップのゴールドは Web と主要な色が同じ`, () => {
    const sel = `html\[data-palette="gold-ivory"\]\[data-theme="${theme}"\]`;
    const d = block(desktop, sel);
    const w = block(web, sel);
    for (const k of GOLD) assert.equal(d[k], w[k], `gold ${theme} --${k}`);
    assert.equal(d['accent-base'], w.action, `gold ${theme} action`);
    assert.equal(d['accent-base-hover'], w['action-hover'] ?? d['accent-base-hover'], `gold ${theme} action-hover`);
  });
}

test('金（暗）: 地と面がすべて暗く、白い面が無い', () => {
  const d = block(desktop, 'html\[data-palette="gold-ivory"\]\[data-theme="dark"\]');
  for (const k of ['bg', 'panel', 'surface-raised', 'surface-sunken', 'content-surface', 'content-nested', 'interactive']) {
    assert.ok(lum(d[k]) < 0.05, `--${k} ${d[k]} is not dark`);
  }
});
