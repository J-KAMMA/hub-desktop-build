import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const html=read('./index.html'),tabs=read('./browser-vertical-tabs.css'),bar=read('./browser-bookmark-bar.css');

test('the bookmark bar is a row of the page column, not of the sidebar',()=>{
  const view=html.slice(html.indexOf('id="view-browser"'),html.indexOf('</section>',html.indexOf('id="view-browser"')));
  assert.match(view,/id="browser-bookmark-bar"/);
  assert.doesNotMatch(html.slice(html.indexOf('<aside'),html.indexOf('</aside>')),/browser-bookmark-bar/);
  assert.doesNotMatch(bar,/position\s*:\s*(absolute|fixed)/);
});
test('the overlaid tab column starts below the bookmark bar and never covers it',()=>{
  assert.match(tabs,/\.browser-tabs-peek:not\(\.browser-tabs-overlay-unavailable\):has\(#browser-bookmark-bar:not\(\[hidden\]\)\) \.sidebar\s*\{[^}]*margin-top:calc\(var\(--tap-compact\) \+ 5px\)/);
  assert.match(tabs,/\.browser-tabs-peek-open[^{]*#sidebar-resizer\s*\{[^}]*top:calc\(var\(--toolbar-height\) \+ var\(--tap-compact\) \+ 5px\)/);
  assert.match(bar,/\.browser-bookmark-row \{[^}]*height:calc\(var\(--tap-compact\) \+ 4px\)/);
});
