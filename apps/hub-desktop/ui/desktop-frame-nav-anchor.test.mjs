import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const frame = readFileSync(new URL('./desktop-frame.css', import.meta.url), 'utf8');
const TEMPLATES = ['stream', 'wide', 'split', 'settings', 'reading', 'browser'];

test('the left nav is the first grid column and nothing before it can move it', () => {
  const columns = frame.match(/grid-template-columns:\s*([^;]+);/)[1].trim();
  assert.match(columns, /^var\(--nav-w\)\s+var\(--spacer\)\s/, 'nav column starts the grid; spacers sit to its right');
  const areas = frame.match(/grid-template-areas:\s*"[^"]*"\s*"([^"]*)"/)[1].trim().split(/\s+/);
  assert.equal(areas[0], 'nav', 'nav is area column 1');
  assert.match(frame, /#hub-shell\.app-shell > \.icon-rail \{ grid-area: nav; \}/);
});

test('no template redefines the grid columns, areas or the nav placement', () => {
  const css = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.css'));
  for (const file of css) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const template of TEMPLATES) {
      const rules = [...text.matchAll(new RegExp(`data-template="${template}"[^{]*\{([^}]*)\}`, 'g'))].map((m) => m[1]);
      for (const body of rules) {
        assert.doesNotMatch(body, /grid-template-(columns|areas)/, `${file}: ${template}`);
      }
    }
  }
  for (const template of TEMPLATES) {
    // Templates only change --main-w / --spacer, never the nav column (browser keeps the 88 rail at the same x).
    const rule = [...frame.matchAll(new RegExp(`data-template="${template}"[^{]*\{([^}]*)\}`, 'g'))].map((m) => m[1]).join(' ');
    assert.doesNotMatch(rule, /--spacer\s*:\s*minmax/);
  }
  assert.match(frame, /\[data-template="browser"\] \{ --main-w: 100vw; --spacer: 0px; \}/);
});
