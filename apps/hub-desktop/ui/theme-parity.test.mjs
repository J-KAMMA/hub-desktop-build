// light の状態色、noir（金・暗）と ivory（金・明）の主要な色が、Web の apps/hub/app/color-system.css と同じ値であること。
// light の地・面・文字は旦那様の指定（2026-11-02、白い地・黒い字）で Web の標準ライトより白く黒いので、ここでは比べない。
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

const LIGHT = ['action-text', 'positive-bg', 'positive-text', 'warning-bg', 'warning-text', 'danger-bg', 'danger-text'];
// line（区切り線）は divider の最低比 1.3:1 を守るため Web の値より少し濃い（2026-11-02）ので比べない。
const GOLD = ['bg', 'panel', 'surface-raised', 'surface-sunken', 'content-surface', 'content-nested', 'interactive', 'interactive-hover', 'selected', 'selected-text', 'line-strong', 'text', 'muted', 'text-meta', 'action-text', 'chip-bg', 'chip-text', 'chip-selected-bg', 'chip-selected-text'];

// The desktop Light template became pure black and white on 2026-11-02 (owner: ライトはグレーじゃなくて白黒がいい),
// so it no longer mirrors the web light palette until the web follows. It is pinned to black and white instead.
test('標準（明）: デスクトップのライトは白と黒だけ', () => {
  const d = { ...block(desktop, 'html\[data-theme="light"\]'), ...block(desktop, '\[data-template="light"\]') };
  for (const k of ['bg', 'panel']) assert.equal(d[k], '#ffffff', `light --${k}`);
  for (const k of ['text', 'line', 'line-strong', 'accent-base']) assert.equal(d[k], '#000000', `light --${k}`);
});

for (const [theme, id] of [['dark', 'noir'], ['light', 'ivory']]) {
  test(`金（${theme === 'dark' ? '暗 = noir' : '明 = ivory'}）: デスクトップのゴールドは Web と主要な色が同じ`, () => {
    const d = block(desktop, `\[data-template="${id}"\]`);
    const w = block(web, `html\[data-palette="gold-ivory"\]\[data-theme="${theme}"\]`);
    // 2026-11-09 craft A: Desktop ivory の選択行は中立の灰（Web の金の面 #d9c496 をやめ、左の金の1px線で示す）。
    for (const k of GOLD) { if (id === 'ivory' && k === 'selected') { assert.equal(d[k], '#cdc8bd', 'ivory --selected is neutral'); continue; } assert.equal(d[k], w[k], `gold ${theme} --${k}`); }
    assert.equal(d['accent-base'], w.action, `gold ${theme} action`);
    assert.equal(d['accent-base-hover'], w['action-hover'] ?? d['accent-base-hover'], `gold ${theme} action-hover`);
  });
}

test('金（暗）: 地と面がすべて暗く、白い面が無い', () => {
  const d = block(desktop, '\[data-template="noir"\]');
  for (const k of ['bg', 'panel', 'surface-raised', 'surface-sunken', 'content-surface', 'content-nested', 'interactive']) {
    assert.ok(lum(d[k]) < 0.05, `--${k} ${d[k]} is not dark`);
  }
});
