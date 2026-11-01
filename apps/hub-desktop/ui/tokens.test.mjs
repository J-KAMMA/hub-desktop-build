import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = stripComments(read('tokens.css'));

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
function block(selectorPattern) {
  const match = tokens.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `block ${selectorPattern} exists`);
  return declarations(match[1]);
}
const light = block('html\\[data-theme="light"\\]');
const dark = block('html\\[data-theme="dark"\\],\\s*html:not\\(\\[data-theme\\]\\)');
const shared = block(':root');

function resolver(theme) {
  const resolve = (name, seen = new Set()) => {
    if (seen.has(name)) throw Error(`cycle at ${name}`);
    seen.add(name);
    const raw = theme.get(name) ?? shared.get(name) ?? lateShared.get(name);
    assert.ok(raw !== undefined, `${name} defined`);
    const ref = raw.match(/^var\((--[\w-]+)\)$/);
    return ref ? resolve(ref[1], seen) : raw;
  };
  return resolve;
}
// 末尾の :root（旧名の別名）ブロック
const lateShared = (() => {
  const all = [...tokens.matchAll(/:root\s*\{([^}]*)\}/g)];
  return declarations(all.at(-1)[1]);
})();

function rgb(hex) {
  const m = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  assert.ok(m, `opaque hex expected, got ${hex}`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const REQUIRED = [
  '--bg', '--panel', '--surface-raised', '--surface-sunken', '--content-surface', '--content-surface-hover', '--content-nested',
  '--interactive', '--interactive-hover', '--selected', '--line', '--line-strong', '--text', '--muted',
  '--action', '--action-hover', '--action-active', '--action-text', '--link-color', '--focus-ring', '--reaction-like',
  '--positive-bg', '--positive-text', '--warning-bg', '--warning-text', '--danger-bg', '--danger-text', '--overlay',
  '--material-bar', '--material-bar-solid', '--material-sheet', '--material-sheet-solid',
  '--media-badge-bg', '--media-badge-text', '--media-outline', '--media-app-bg', '--media-app-text',
  '--elevation-1', '--elevation-2', '--accent-base',
];

test('both themes define every token, and the single accent token feeds --action', () => {
  for (const [label, theme] of [['light', light], ['dark', dark]]) {
    for (const name of REQUIRED) assert.ok(theme.has(name), `${label} defines ${name}`);
    assert.equal(theme.get('--action'), 'var(--accent-base)', `${label} --action comes from the accent token`);
  }
  for (const name of ['--font-ui', '--space-8', '--radius-xs', '--radius-pill', '--type-caption', '--ease-out', '--dur-press', '--control-h', '--titlebar-h']) {
    assert.ok(shared.has(name), `shared ${name}`);
  }
});

test('dark tokens keep the owner-chosen tight black ground and surfaces', () => {
  const r = resolver(dark);
  assert.deepEqual(['--bg', '--panel', '--content-surface', '--surface-raised', '--line', '--text', '--muted'].map((name) => r(name)),
    ['#0b0b0d', '#111114', '#141417', '#18181c', '#232329', '#ececf1', '#a4a4b0']);
});

test('status colours: dark values apply whatever the OS scheme is (no prefers-color-scheme anywhere in the UI css)', () => {
  const r = resolver(dark);
  assert.equal(r('--warning-bg'), '#37301f');
  assert.equal(r('--danger-text'), '#f3a8b1');
  assert.equal(r('--danger'), '#f3a8b1');
  assert.equal(r('--overlay').replace(/\s/g, ''), 'rgba(0,0,0,.6)');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    assert.doesNotMatch(stripComments(read(file)), /prefers-color-scheme/, file);
  }
});

test('status colours meet 4.5:1 on their own background and on the page surfaces in both themes', () => {
  for (const [label, theme] of [['light', light], ['dark', dark]]) {
    const r = resolver(theme);
    for (const kind of ['warning', 'danger', 'positive']) {
      if (kind !== 'warning') {
        for (const surface of ['--content-surface', '--bg', '--panel']) {
          assert.ok(contrast(r(`--${kind}-text`), r(surface)) >= 4.5, `${label} ${kind}-text on ${surface}`);
        }
      }
      assert.ok(contrast(r(`--${kind}-text`), r(`--${kind}-bg`)) >= 4.5, `${label} ${kind}-text on ${kind}-bg`);
    }
    assert.ok(contrast(r('--text'), r('--material-bar-solid')) >= 4.5, `${label} text on material-bar-solid`);
    assert.ok(contrast(r('--muted'), r('--material-bar-solid')) >= 4.5, `${label} muted on material-bar-solid`);
    assert.ok(contrast(r('--text'), r('--content-surface')) >= 4.5, `${label} text on content-surface`);
    assert.ok(contrast(r('--action-text'), r('--action')) >= 4.5, `${label} action-text on action`);
    assert.ok(contrast(r('--link-color'), r('--content-surface')) >= 4.5, `${label} link on content-surface`);
  }
});

test('focus colour is achromatic and matches the web (#3a3a3c / #d1d1d6)', () => {
  assert.equal(resolver(light)('--focus-ring'), '#3a3a3c');
  assert.equal(resolver(dark)('--focus-ring'), '#d1d1d6');
  for (const theme of [light, dark]) {
    const [r, g, b] = rgb(resolver(theme)('--focus-ring'));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 8, 'focus ring has no hue');
  }
});

test('no focus rule draws a glow: field :focus uses border only, others use outline', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const css = stripComments(read(file));
    for (const [, selector, body] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      if (!/:focus/.test(selector)) continue;
      const shadow = body.match(/box-shadow\s*:\s*([^;}]*)/);
      if (shadow && !/:hover/.test(selector)) assert.match(shadow[1].trim(), /^none$/, `${file}: ${selector.trim().slice(0, 80)} must not set a focus shadow`);
      assert.doesNotMatch(body, /outline\s*:[^;}]*var\(--action\)/, `${file}: ${selector.trim().slice(0, 80)} outline must be neutral`);
      if (/border-color\s*:\s*var\(--action\)/.test(body)) assert.fail(`${file}: ${selector.trim().slice(0, 80)} focus border must be neutral`);
    }
  }
});

test('field :focus changes the border to the neutral focus token', () => {
  const css = stripComments(read('styles.css'));
  assert.match(css, /textarea:focus,select:focus\{border-color:var\(--focus-ring\);box-shadow:none;outline:none\}/);
});

test('new foundation and lane css use tokens only: no raw colours', () => {
  const raw = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bwhite(?![-\w])|\bblack(?![-\w])/;
  for (const file of ['desktop-foundation.css', 'desktop-shell.css', 'desktop-social.css', 'desktop-media.css', 'desktop-commerce.css']) {
    assert.doesNotMatch(stripComments(read(file)), raw, file);
  }
});

test('font stack is the web one (no proprietary Apple faces) and weights never use 500, 600, 650, 760 or 900 (400 · 700 · 800 only)', () => {
  const css = stripComments(read('tokens.css'));
  assert.match(css, /"Segoe UI Variable Text"/);
  assert.match(css, /"Hiragino Sans"/);
  assert.doesNotMatch(css, /SF Pro/);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    assert.doesNotMatch(stripComments(read(file)), /font-weight\s*:\s*(500|600|650|760|900)\b/, file);
  }
});

test('html loads tokens first; newtab loads tokens and the early appearance script; theme-black is gone', () => {
  const index = read('index.html');
  const newtab = read('newtab.html');
  assert.ok(index.indexOf('tokens.css') > 0 && index.indexOf('tokens.css') < index.indexOf('styles.css'));
  assert.ok(newtab.indexOf('tokens.css') > 0 && newtab.indexOf('tokens.css') < newtab.indexOf('styles.css'));
  assert.ok(newtab.includes('appearance-early.js'));
  assert.doesNotMatch(index + newtab, /theme-black/);
  assert.ok(!readdirSync(dir).includes('theme-black.css'));
  const order = ['article-reader.css', 'desktop-foundation.css', 'desktop-shell.css', 'desktop-social.css', 'desktop-media.css', 'desktop-commerce.css'].map((f) => index.indexOf(f));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'foundation and lane files are linked in order after the existing css');
});

test('translucency has an opaque fallback: unsupported, OS reduced, in-app reduced, and Mica opt-in', () => {
  const css = stripComments(read('desktop-foundation.css'));
  assert.match(css, /@supports not \(backdrop-filter: blur\(1px\)\)/);
  assert.match(css, /prefers-reduced-transparency: reduce/);
  assert.match(css, /html\[data-transparency="reduce"\]/);
  assert.match(css, /html\[data-material="mica"\]/);
  assert.match(css, /data-material="mica"\]\[data-transparency="reduce"\]/);
});

test('foundation animations are finite (no endless animation while idle)', () => {
  const css = stripComments(read('desktop-foundation.css'));
  assert.doesNotMatch(css, /animation[^;]*\binfinite\b/);
});

test('Mica tint keeps body text >= 4.5:1 over every backdrop: matching, wallpaper-tinted, bright, wrong-theme and failed (black)', () => {
  const alphaOf = (theme) => Number(/color-mix\(in srgb, var\(--bg\) (\d+)%, transparent\)/.exec(theme.get('--material-mica-tint') ?? '')?.[1]);
  const mix = (fg, alpha, bg) => '#' + fg.map((v, i) => Math.round(v * alpha / 100 + bg[i] * (1 - alpha / 100)).toString(16).padStart(2, '0')).join('');
  assert.ok(alphaOf(light) >= 85, 'light tint is strong enough to survive a dark or black backdrop');
  // MicaDark is a dark grey tinted by the wallpaper (up to about #3c3c3c); MicaLight is a light grey (down to about #c8c8c8).
  // Light is also checked over a bright wallpaper, a dark Mica (OS theme mismatch) and a failed backdrop (black).
  const cases = [
    [dark, [[0x3c, 0x3c, 0x3c]]],
    [light, [[0xff, 0xff, 0xff], [0xf3, 0xf3, 0xf3], [0xc8, 0xc8, 0xc8], [0x3c, 0x3c, 0x3c], [0, 0, 0]]],
  ];
  for (const [theme, backdrops] of cases) {
    const resolve = resolver(theme);
    for (const backdrop of backdrops) {
      const surface = mix(rgb(resolve('--bg')), alphaOf(theme), backdrop);
      for (const name of ['--text', '--muted']) assert.ok(contrast(resolve(name), surface) >= 4.5, `${name} on ${surface} over ${backdrop}: ${contrast(resolve(name), surface).toFixed(2)}`);
    }
  }
  const css = stripComments(read('desktop-shell.css')) + stripComments(read('desktop-foundation.css'));
  assert.doesNotMatch(css, /data-material="mica"\][^{]*\{\s*background:\s*transparent;\s*backdrop-filter/, 'Mica areas use the tint, not bare transparency');
});

test('light theme: text and icon tokens reach 4.5:1 on every light surface (muted also 3:1 as an icon)', () => {
  const r = resolver(light);
  const surfaces = ['--bg', '--panel', '--surface-raised', '--surface-sunken', '--content-surface', '--content-nested', '--interactive', '--interactive-hover', '--selected'];
  for (const surface of surfaces) {
    for (const name of ['--text', '--muted', '--link-color']) {
      assert.ok(contrast(r(name), r(surface)) >= 4.5, `light ${name} on ${surface}: ${contrast(r(name), r(surface)).toFixed(2)}`);
    }
  }
  assert.ok(contrast(r('--action'), r('--content-surface')) >= 3, 'accent as an icon or large text');
});

test('light theme: selected is visibly darker than the page and than hover; hairlines and field borders are visible', () => {
  const r = resolver(light);
  assert.ok(contrast(r('--selected'), r('--bg')) >= 1.25, 'selected vs bg');
  assert.ok(contrast(r('--selected'), r('--panel')) >= 1.35, 'selected vs panel');
  assert.ok(luminance(r('--selected')) < luminance(r('--interactive-hover')), 'selected is stronger than hover');
  const alphaOf = (name) => Number(/rgba\(0,\s*0,\s*0,\s*(\.?\d+(?:\.\d+)?)\)/.exec(r(name))?.[1]);
  const over = (alpha, bg) => '#' + rgb(bg).map((v) => Math.round(v * (1 - alpha)).toString(16).padStart(2, '0')).join('');
  for (const surface of ['--panel', '--bg']) {
    assert.ok(contrast(over(alphaOf('--line'), r(surface)), r(surface)) >= 1.3, `hairline on ${surface}`);
    assert.ok(contrast(over(alphaOf('--line-strong'), r(surface)), r(surface)) >= 3, `component boundary on ${surface}`);
  }
});

// ---- ゴールド（2026-10-16）。ライト／ダークの値の上に data-palette が重なる。 ----
const goldOver = (base, theme) => new Map([...base, ...block(`html\\[data-palette="gold-ivory"\\]\\[data-theme="${theme}"\\]`)]);
const goldLight = goldOver(light, 'light');
const goldDark = goldOver(dark, 'dark');
const GOLD_SURFACES = ['--bg', '--panel', '--surface-raised', '--surface-sunken', '--content-surface', '--content-nested', '--interactive'];

test('gold: text roles reach 4.5:1 on every surface in both themes; gold is never body text or a divider', () => {
  for (const [label, theme] of [['light', goldLight], ['dark', goldDark]]) {
    const r = resolver(theme);
    for (const surface of GOLD_SURFACES) {
      for (const name of ['--text', '--muted', '--text-meta', '--link-color']) {
        assert.ok(contrast(r(name), r(surface)) >= 4.5, `gold ${label} ${name} on ${surface}: ${contrast(r(name), r(surface)).toFixed(2)}`);
      }
      assert.ok(contrast(r('--action'), r(surface)) >= 3, `gold ${label} action as icon on ${surface}: ${contrast(r('--action'), r(surface)).toFixed(2)}`);
      assert.ok(contrast(r('--line-strong'), r(surface)) >= 3, `gold ${label} line-strong on ${surface}`);
    }
    assert.ok(contrast(r('--action-text'), r('--action')) >= 4.5, `gold ${label} button text`);
    assert.ok(contrast(r('--selected-text'), r('--selected')) >= 4.5, `gold ${label} selected text`);
    assert.ok(contrast(r('--chip-text'), r('--chip-bg')) >= 4.5, `gold ${label} chip text`);
    assert.ok(contrast(r('--chip-selected-text'), r('--chip-selected-bg')) >= 4.5, `gold ${label} selected chip text`);
    assert.equal(theme.get('--action'), 'var(--accent-base)', `gold ${label} keeps the single accent token`);
    for (const name of ['--text', '--muted', '--text-meta', '--link-color', '--line', '--line-strong']) {
      assert.notEqual(r(name), r('--action'), `gold ${label} ${name} is not the gold`);
    }
  }
});

test('gold: the palette block does not touch the neutral focus ring', () => {
  for (const theme of ['light', 'dark']) assert.ok(!block(`html\\[data-palette="gold-ivory"\\]\\[data-theme="${theme}"\\]`).has('--focus-ring'));
  assert.equal(resolver(goldLight)('--focus-ring'), '#3a3a3c');
  assert.equal(resolver(goldDark)('--focus-ring'), '#d1d1d6');
});

test('gold: Mica tint keeps text, muted and meta >= 4.5:1 over matching, bright, wrong-theme and failed (black) backdrops', () => {
  const alphaOf = (theme) => Number(/color-mix\(in srgb, var\(--bg\) (\d+)%, transparent\)/.exec(theme.get('--material-mica-tint') ?? '')?.[1]);
  const mix = (fg, alpha, bg) => '#' + fg.map((v, i) => Math.round(v * alpha / 100 + bg[i] * (1 - alpha / 100)).toString(16).padStart(2, '0')).join('');
  const cases = [
    [goldDark, [[0x3c, 0x3c, 0x3c]]],
    [goldLight, [[0xff, 0xff, 0xff], [0xf3, 0xf3, 0xf3], [0xc8, 0xc8, 0xc8], [0x3c, 0x3c, 0x3c], [0, 0, 0]]],
  ];
  for (const [theme, backdrops] of cases) {
    const resolve = resolver(theme);
    for (const backdrop of backdrops) {
      const surface = mix(rgb(resolve('--bg')), alphaOf(theme), backdrop);
      for (const name of ['--text', '--muted', '--text-meta']) assert.ok(contrast(resolve(name), surface) >= 4.5, `gold ${name} on ${surface} over ${backdrop}: ${contrast(resolve(name), surface).toFixed(2)}`);
    }
  }
});
