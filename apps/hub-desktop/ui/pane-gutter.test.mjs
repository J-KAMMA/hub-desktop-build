import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// jsdom は配置を測れないので、左右対称を決める CSS の値そのものを確かめる。
// 実測（Playwright, 1280x800 と 1920x1080, 右列を開く）は 左右の差 0 だった。
const css=readFileSync(new URL('./desktop-shell.css',import.meta.url),'utf8');
const rule=selector=>{
  const start=css.lastIndexOf(selector+' {');
  assert.ok(start>=0,`rule_missing:${selector}`);
  return css.slice(start,css.indexOf('}',start));
};
test('one gutter token, one hairline, one surface for both flanking columns',()=>{
  const root=rule('#hub-shell');
  // 2026-11-01 統一デザインシステム: 本文の左右は --ds-page-inset（16）。左右は同じまま。
  assert.match(root,/--pane-gutter:\s*var\(--ds-page-inset\)/);
  assert.match(root,/--pane-hairline:\s*1px solid var\(--hairline\)/);
  // 本文と右の列は地のまま（2026-10-24 所有者「丸くして色変えるの微妙かも」）。
  assert.match(root,/--pane-surface:\s*var\(--bg\)/);
});
test('main reserves the scrollbar width on both edges',()=>{
  assert.match(css,/#hub-shell \.workspace-main \{ scrollbar-gutter:\s*stable both-edges; \}/);
});
test('views take the gutter from the token on both sides',()=>{
  assert.match(rule('#hub-shell .view:not(#view-browser):not(#view-ai)'),/padding-inline:\s*var\(--pane-gutter\)/);
});
test('flat canvas: one ground, no rounded or tinted panel, one hairline between columns',()=>{
  assert.match(rule('#hub-shell .sidebar'),/border-right:\s*var\(--pane-hairline\)/);
  assert.match(css,/#hub-shell \.icon-rail \{ border-right: var\(--pane-hairline\); \}/);
  for(const selector of ['#hub-shell .workspace-main','#hub-shell.rail-open .rail-body']){
    const surface=rule(selector);
    assert.match(surface,/border:\s*0;/,selector);
    assert.match(surface,/border-radius:\s*0;/,selector);
    assert.match(surface,/background:\s*var\(--pane-surface\)/,selector);
    assert.match(surface,/margin:\s*0;/,selector);
  }
  assert.match(css,/#hub-shell\.rail-open \.rail \{ border-left: var\(--pane-hairline\); \}/);
  // 窓は Mica なので、列の幅つまみも不透明の地で塗る（すき間に窓の裏が線で見えた）。
  assert.match(css,/#hub-shell \.column-resizer \{ background: var\(--pane-surface\); \}/);
  // つまみが列の線を覆うので、境目の線はつまみの中に引く（「列の境界がなくなってる」）。
  assert.match(css,/#hub-shell \.column-resizer::before \{ width: 1px; left: 50%; right: auto; background: var\(--line\); \}/);
});
test('no raw colour in the gutter rules',()=>{
  const block=css.slice(css.indexOf('本文の左右の余白'));
  assert.doesNotMatch(block,/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
});
test('right-rail browser: toolbar is the top row and at most 36px; page title moves to the address tooltip',()=>{
  // 2026-10-17 所有者：右列ブラウザはページの面積を最大に。実測（Playwright 1280x800）で見出し行 64＋操作列 45 → 操作列 36 だけ。
  const rb=readFileSync(new URL('./rail-browser.css',import.meta.url),'utf8');
  assert.match(rb,/#hub-shell\.rail-browser-view \.rail-activity-head \{ display: none; \}/);
  assert.match(rb,/min-height:\s*var\(--control-h-lg\)/);
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/class="rail-view rail-view--browser" data-rail-view="browser" aria-label="ブラウザ"/);
  const js=readFileSync(new URL('./rail-browser.mjs',import.meta.url),'utf8');
  assert.match(js,/address\.title = state\.title/);
});
