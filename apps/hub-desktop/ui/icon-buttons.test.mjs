// 補助の絵ボタン（窓操作・×・戻る/進む・更新など）は全部同じ寸法（所有者 2026-11-09）。
// 寸法の持ち主は tokens.css の --icon-btn の1か所。icon-buttons.css が最後に読まれて全部へ当てる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const tokens = read('tokens.css');
const css = read('icon-buttons.css');
const html = read('index.html');

// 寸法を揃える対象。足すときはここと icon-buttons.css の両方へ。
const TARGETS = ['.window-control', '.app-toolbar .toolbar-button', '.rb-button', '.rail-activity-actions .btn-icon', '.uc-tool[aria-label="閉じる"]', '.yt-dock-close', '.media-lightbox-close', '.community-composer-panel-close', '#browser-find-close'];
const SIZED = ['width', 'min-width', 'height', 'min-height'];
const specificity = (selector) => (selector.match(/#[\w-]+|:not\(#_\)/g) ?? []).length;
const rules = (text) => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }));

test('one token owns the size, glyph, stroke, gap and hit area', () => {
  for (const name of ['--icon-btn', '--icon-btn-glyph', '--icon-btn-stroke', '--icon-btn-gap', '--icon-btn-hit']) {
    assert.match(tokens, new RegExp(`${name}:\s*[^;]+;`), name);
  }
  assert.match(tokens, /--icon-btn:\s*32px/);
  assert.match(tokens, /--icon-btn-glyph:\s*16px/);
});

test('icon-buttons.css is the last stylesheet and sizes every target from the token only', () => {
  const links = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map((m) => m[1]);
  assert.equal(links.at(-1), 'icon-buttons.css');
  const base = rules(css).find((r) => r.body.includes('width: var(--icon-btn)'));
  for (const target of TARGETS) assert.ok(base.selectors.some((s) => s.endsWith(` ${target}`)), `${target} is sized`);
  for (const rule of rules(css)) {
    for (const [, prop, value] of rule.body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
      if (SIZED.includes(prop)) assert.match(value, /var\(--(icon-btn|icon-btn-glyph|rail-w)\)/, `${prop}: ${value}`);
    }
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /(?<![-\w])(width|height)\s*:\s*\d/);
});

test('no other rule can resize a target: every competing size rule is weaker than icon-buttons.css', () => {
  const mine = Math.min(...rules(css).flatMap((r) => r.selectors.map(specificity)).filter((n) => n >= 8));
  const markers = TARGETS.map((t) => t.split(' ').at(-1).replace(/\[.*\]/, ''));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'icon-buttons.css')) {
    for (const rule of rules(read(file))) {
      for (const selector of rule.selectors) {
        if (!markers.some((m) => selector.split(/[\s>+~]/).at(-1).startsWith(m) || selector.includes(`${m}:`) )) continue;
        const sizes = [...rule.body.matchAll(/(?:^|;)\s*(width|min-width|height|min-height)\s*:\s*([^;]+)/g)];
        if (!sizes.length) continue;
        assert.ok(specificity(selector) < mine, `${file}: ${selector} is as strong as icon-buttons.css`);
        assert.doesNotMatch(rule.body, /(width|height)\s*:[^;]*!important/, `${file}: ${selector} uses !important`);
      }
    }
  }
});

test('the window controls fit three boxes, two gaps and a margin, and keep the danger hover', () => {
  const shell = read('desktop-shell.css');
  assert.match(shell, /--window-controls-w:\s*calc\(var\(--icon-btn\) \* 3 \+ var\(--icon-btn-gap\) \* 2 \+ var\(--space-2\)\)/);
  assert.match(css, /\.window-control\.window-control-close:hover\s*\{[^}]*background:\s*var\(--danger\)/);
});

test('only a × with no neighbouring button gets the 44px hit extender', () => {
  const extender = rules(css).find((r) => r.selectors.some((s) => s.endsWith('::before')));
  const targets = extender.selectors.map((s) => s.replace(/^body(:not\(#_\))+ /, '').replace(/::before$/, ''));
  for (const group of ['.window-control', '.toolbar-button', '.rb-button', '.btn-icon']) assert.ok(!targets.some((t) => t.includes(group)), `${group} sits beside siblings`);
  assert.match(extender.body, /inset:\s*calc\(\(var\(--icon-btn\) - var\(--icon-btn-hit\)\) \/ 2\)/);
});

test('every window control and toolbar button in index.html is covered by a target', () => {
  for (const cls of ['window-control', 'toolbar-button', 'rb-button']) {
    assert.ok(html.includes(`class="${cls}`) || html.includes(` ${cls} `) || html.includes(` ${cls}"`), cls);
  }
  assert.ok(TARGETS.some((t) => t.includes('.window-control')) && TARGETS.some((t) => t.includes('.toolbar-button')) && TARGETS.some((t) => t.includes('.rb-button')));
});
