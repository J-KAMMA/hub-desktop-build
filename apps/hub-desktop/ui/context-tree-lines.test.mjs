import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 内側左列の行は、ファイルの木のような縦の線と枝の線にぶら下がる（2026-11-02、所有者の指定）。
const css = readFileSync(new URL("./desktop-views.css", import.meta.url), "utf8");
const section = css.slice(css.indexOf("Tree lines in the context column"));

test("context rows hang off a vertical guide with an elbow, outside the selected surface", () => {
  assert.ok(section.length > 0, "tree-line section exists");
  assert.match(section, /\.sidebar-context-item:not\(#_\) \{[^}]*margin-left: 26px/);
  assert.match(section, /::before[^{]*\{[^}]*border-left: 1px solid var\(--line-strong\)/);
  assert.match(section, /::after \{[^}]*border-bottom-left-radius: 8px/);
});

test("the selected row keeps its guide, and the last row of a group ends in its curved elbow", () => {
  assert.match(section, /:is\(\.on, \[aria-current="true"\], \[aria-current="page"\]\)::before/);
  assert.match(section, /:is\(:last-child, :has\(\+ :not\(\.sidebar-context-item\)\)\)::before \{ content: none; \}/);
});

test("the guide reaches up to the group heading", () => {
  assert.match(section, /\.nav-group, \.sidebar-context-title\) \+ \.sidebar-context-item:not\(#_\)::before/);
});

const tree = css.slice(css.indexOf("The feed column is a tree of three roots"));

test("feed tree: roots carry no lines, children hang from the root's label", () => {
  assert.ok(tree.length > 0, "tree section exists");
  assert.match(tree, /\.sidebar-tree-root:not\(#_\)::before,\s*#hub-shell #sidebar-context \.sidebar-tree-root:not\(#_\)::after \{ content: none; \}/);
  // Label offset 42px (padding + icon + gap) + 4px = 46px = 30px container padding + 22px margin - 6px guide offset.
  assert.match(tree, /\.sidebar-tree-children \{[^}]*padding-left: 30px/);
  assert.match(tree, /margin-left: 22px/);
  assert.match(tree, /left: -6px/);
});

test("feed tree: sub-headings sit on the guide, the first child reaches up under the root, the last ends in the curved elbow", () => {
  assert.match(tree, /:is\(\.sidebar-context-item, \.sidebar-tree-sub, \.sidebar-tree-note\):not\(#_\)::before \{[^}]*border-left: 1px solid var\(--line-strong\)/);
  assert.match(tree, /:is\(\.sidebar-context-item, \.sidebar-tree-sub, \.sidebar-tree-note\):not\(#_\)::after \{[^}]*border-bottom-left-radius: 8px/);
  assert.match(tree, /\.is-tree-last:not\(#_\)::before \{ content: none; \}/);
  assert.match(tree, /\.is-tree-first:not\(#_\)::before \{ top: -8px; \}/);
  assert.match(tree, /\.sidebar-tree-sub,\s*#hub-shell #sidebar-context \.sidebar-tree-note \{[^}]*font-size: var\(--type-caption\)/);
});
