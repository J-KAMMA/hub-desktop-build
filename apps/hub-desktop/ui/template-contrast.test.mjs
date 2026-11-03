// 5 つのカラーテンプレート（light / dark / noir / ivory / midnight）の WCAG AA を、tokens.css の値から計算して確かめる。
// くっきり表示（data-crisp）の on / off の両方で、同じ基準を満たし、off より弱くならず、色相を変えないこと。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const TEMPLATES = ['light', 'dark', 'noir', 'ivory', 'midnight'];

function declarations(body) {
  const map = new Map();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name.startsWith('--')) map.set(name, part.slice(at + 1).trim());
  }
  return map;
}
const blockAfter = (selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `block ${selector}`);
  return declarations(css.slice(at, css.indexOf('}', at)).split('{')[1]);
};
const schemeOf = (id) => (id === 'light' || id === 'ivory' ? 'light' : 'dark');

/** その組み合わせで有効なトークン（明暗の骨格 → テンプレート → くっきり）を var() まで解決して返す。 */
function tokensFor(id, crisp) {
  const raw = new Map([
    ...blockAfter(schemeOf(id) === 'light' ? 'html[data-theme="light"]' : 'html[data-theme="dark"],\nhtml:not([data-theme])'),
    ...blockAfter(`[data-template="${id}"]`),
    ...(crisp ? blockAfter(`[data-template="${id}"][data-crisp]`) : []),
  ]);
  const get = (name, seen = new Set()) => {
    assert.ok(!seen.has(name), `cycle at ${name}`);
    seen.add(name);
    const value = raw.get(name);
    assert.ok(value !== undefined, `${id}: ${name} is defined`);
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    return ref ? get(ref[1], seen) : value;
  };
  return get;
}

const hex = (value) => {
  const m = value.match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `opaque hex expected, got ${value}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
};
/** #rrggbb か rgba(0,0,0,a)（背景の上に重ねる）を、不透明な [r,g,b] にする。 */
function opaque(value, ground) {
  const a = value.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*(\.?\d+(?:\.\d+)?)\s*\)$/);
  if (!a) return hex(value);
  const alpha = Number(a[4]);
  return [1, 2, 3].map((i, k) => Math.round(Number(a[i]) * alpha + ground[k] * (1 - alpha)));
}
const luminance = ([r, g, b]) => {
  const [lr, lg, lb] = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
export const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const hsl = ([r, g, b]) => {
  const [x, y, z] = [r, g, b].map((v) => v / 255);
  const max = Math.max(x, y, z); const min = Math.min(x, y, z); const d = max - min;
  let h = 0;
  if (d > 0) { h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4; h = (h * 60 + 360) % 360; }
  const l = (max + min) / 2;
  return { h, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), spread: Math.round((max - min) * 255) };
};

const GROUNDS = ['--bg', '--panel', '--content-surface'];
const surface = (get, name) => hex(get(name));
const against = (get, token, ground) => ratio(opaque(get(token), surface(get, ground)), surface(get, ground));
const min = (get, token) => Math.min(...GROUNDS.map((g) => against(get, token, g)));

for (const crisp of [false, true]) {
  for (const id of TEMPLATES) {
    test(`${id}${crisp ? ' + くっきり' : ''}: WCAG AA (body 4.5, muted 4.5, state lines 3, dividers 1.3)`, () => {
      const get = tokensFor(id, crisp);
      for (const ground of [...GROUNDS, '--surface-raised']) {
        assert.ok(against(get, '--text', ground) >= 4.5, `body text on ${ground}: ${against(get, '--text', ground).toFixed(2)}`);
        assert.ok(against(get, '--muted', ground) >= 4.5, `muted text on ${ground}: ${against(get, '--muted', ground).toFixed(2)}`);
        assert.ok(against(get, '--text-meta', ground) >= 4.5, `meta text on ${ground}: ${against(get, '--text-meta', ground).toFixed(2)}`);
      }
      assert.ok(min(get, '--link-color') >= 4.5, `link: ${min(get, '--link-color').toFixed(2)}`);
      assert.ok(min(get, '--line-strong') >= 3, `field and state borders: ${min(get, '--line-strong').toFixed(2)}`);
      assert.ok(min(get, '--emphasis') >= 3, `emphasis (selected outline, state): ${min(get, '--emphasis').toFixed(2)}`);
      assert.ok(min(get, '--focus-ring') >= 3, `focus ring: ${min(get, '--focus-ring').toFixed(2)}`);
      assert.ok(min(get, '--line') >= 1.3, `dividers: ${min(get, '--line').toFixed(2)}`);
      assert.ok(ratio(hex(get('--action-text')), hex(get('--action'))) >= 4.5, 'text on the action colour');
    });
  }
}

test('くっきり表示: every template gets stronger text and lines, never weaker, and the hue does not move', () => {
  for (const id of TEMPLATES) {
    const off = tokensFor(id, false);
    const on = tokensFor(id, true);
    for (const token of ['--text', '--muted', '--text-meta', '--line', '--line-strong']) {
      for (const ground of GROUNDS) {
        assert.ok(against(on, token, ground) >= against(off, token, ground), `${id} ${token} on ${ground} is not weaker with くっきり`);
      }
      assert.ok(min(on, token) > min(off, token) || token === '--line' || min(off, token) >= 20.9, `${id} ${token} gets stronger`);
      const before = opaque(off(token), surface(off, '--bg'));
      const after = opaque(on(token), surface(on, '--bg'));
      const [a, b] = [hsl(before), hsl(after)];
      if (a.spread > 12 && b.spread > 12) {
        const turn = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
        assert.ok(turn <= 8, `${id} ${token} hue moved ${turn.toFixed(1)} degrees`);
      }
    }
    for (const token of ['--bg', '--panel', '--content-surface', '--accent-base']) assert.equal(on(token), off(token), `${id} くっきり keeps ${token}`);
  }
});

test('gold is a line colour in noir and ivory only; the other templates carry no gold', () => {
  const isGold = (rgb) => { const c = hsl(rgb); return c.spread > 20 && c.h >= 30 && c.h <= 55; };
  for (const id of TEMPLATES) {
    for (const crisp of [false, true]) {
      const get = tokensFor(id, crisp);
      const ground = surface(get, '--bg');
      const colours = ['--emphasis', '--accent-base', '--line', '--line-strong', '--focus-ring', '--selected', '--interactive', '--link-color'].map((name) => opaque(get(name), ground));
      if (id === 'noir' || id === 'ivory') {
        assert.ok(isGold(opaque(get('--emphasis'), ground)), `${id} emphasis is gold`);
        assert.ok(isGold(opaque(get('--line-strong'), ground)), `${id} line-strong is gold`);
      } else {
        assert.ok(colours.every((c) => !isGold(c)), `${id} has no gold`);
      }
    }
  }
});

test('the templates have plain grounds: no gradients, images or textures in tokens.css', () => {
  assert.doesNotMatch(css, /gradient\(|url\(/);
  for (const id of TEMPLATES) {
    const get = tokensFor(id, false);
    for (const name of ['--bg', '--panel', '--surface-raised', '--content-surface']) assert.match(get(name), /^#[0-9a-f]{6}$/i, `${id} ${name} is one plain colour`);
  }
});

test('light is a white ground with black text; dark is a black ground with white text; midnight is a deep navy', () => {
  const white = (id, token) => luminance(hex(tokensFor(id, false)(token)));
  assert.ok(white('light', '--bg') > 0.95 && white('light', '--text') < 0.01);
  assert.ok(white('dark', '--bg') < 0.01 && white('dark', '--text') > 0.8);
  const navy = hsl(hex(tokensFor('midnight', false)('--bg')));
  assert.ok(navy.h >= 200 && navy.h <= 240 && luminance(hex(tokensFor('midnight', false)('--bg'))) < 0.02, 'midnight ground is a dark navy');
  assert.ok(luminance(hex(tokensFor('noir', false)('--bg'))) < 0.01);
});
