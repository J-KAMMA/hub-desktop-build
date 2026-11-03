import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ボタンは平ら（2026-11-02、所有者の指定）：影・凸・グラデーション・押したときの移動を持たない。
// 主・副は線だけ、ghost とアイコンは枠なし、hover は --interactive の平らな面。フォーカスの輪（outline）は残す。
const dir = new URL("./", import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith(".css"));
const BUTTONISH = /(^|[\s,>+~(:])(button|\.btn\b|\.btn-[\w-]+|\.approve|\.deny|\.head-action|\.ghost|\[role=["']?button["']?\]|\.chip\b|\.scope\b|\.page-tab)/;

function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  return out;
}

test("no button rule in ui/*.css sets a non-none box-shadow (except focus rings), a gradient background or a translateY press/hover", () => {
  const found = [];
  for (const file of files) {
    for (const { selector, body } of rules(readFileSync(new URL(file, dir), "utf8"))) {
      if (!BUTTONISH.test(selector)) continue;
      for (const declaration of body.split(";")) {
        const [key, ...rest] = declaration.split(":");
        const property = key.trim(), value = rest.join(":").trim();
        const focusRing = /:focus/.test(selector);
        if (property === "box-shadow" && value !== "none" && !/^var\(--shadow-sm\)$/.test(value) && !focusRing) found.push(`${file} ${selector} { ${declaration.trim()} }`);
        if (/^background(-image)?$/.test(property) && /gradient/.test(value)) found.push(`${file} ${selector} { ${declaration.trim()} }`);
        if (property === "transform" && /translateY/.test(value) && /:(hover|active)/.test(selector)) found.push(`${file} ${selector} { ${declaration.trim()} }`);
      }
    }
  }
  assert.deepEqual(found, []);
});

test("the end of desktop-views.css flattens every button kind once, with high specificity", () => {
  const css = readFileSync(new URL("desktop-views.css", dir), "utf8");
  const block = css.slice(css.indexOf("/* ===== Flat buttons"), css.indexOf("/* ===== リストの画面"));
  assert.ok(block.length > 200);
  assert.match(block, /:is\(button, \[role="button"\], \.btn, \.btn-primary, \.btn-secondary, \.btn-ghost, \.btn-icon, \.approve, \.deny, \.head-action, \.ghost\):not\(#_\):not\(#_\):not\(#_\) \{\s*box-shadow: none;/);
  assert.match(block, /\.btn-primary, \.approve\):not\(#_\)[^{]*\{\s*border: 1px solid var\(--ds-btn-primary-line\);\s*background: transparent;/);
  assert.match(block, /:hover:not\(:disabled\) \{ background: var\(--interactive\)/);
  assert.match(block, /\.btn-ghost, button\.ghost, \.btn-icon\):not\(#_\)[^{]*\{ border: 0; background: transparent; \}/);
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ""), /gradient|elevation|--shadow|translateY/);
});

test("作成 is the standard primary outline button: gold line in 黒金, text-colour line in 白黒, no fill", () => {
  const html = readFileSync(new URL("index.html", dir), "utf8");
  assert.match(html, /<button id="lists-create-toggle" class="approve" type="button">＋作成<\/button>/);
  const tokens = readFileSync(new URL("tokens.css", dir), "utf8");
  const mono = tokens.slice(tokens.indexOf("--ds-btn-primary-fg: var(--text);"));
  assert.match(mono, /--ds-btn-primary-fg: var\(--text\);\s*--ds-btn-primary-bg: transparent;\s*--ds-btn-primary-line: var\(--text\);/);
  assert.match(tokens, /html:is\(\[data-template="noir"\], \[data-template="ivory"\]\) \{\s*--ds-btn-primary-fg: var\(--emphasis\);\s*--ds-btn-primary-bg: transparent;\s*--ds-btn-primary-line: var\(--emphasis\);/);
  const views = readFileSync(new URL("desktop-views.css", dir), "utf8");
  assert.match(views, /\.view > :is\(\.view-head, \.page-header\) :is\(\.view-head-actions, \.page-actions\) > :is\(button, \.btn\) \{[^}]*border-radius: var\(--ds-radius-pill\)/);
});
