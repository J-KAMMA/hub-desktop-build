import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

// 2026-11-04 所有者：検索は1番上の欄だけ。今いる項目の種類から見せ、「すべて」で全体に戻る。
test('the top bar search starts from the current section kind', () => {
  const map = source.match(/const SEARCH_SCOPE_BY_VIEW = \{([\s\S]*?)\};/);
  assert.ok(map, 'scope map exists');
  for (const pair of ['articles: "articles"', 'videos: "videos"', 'market: "listings"', 'community: "communities"', 'feed: "posts"']) {
    assert.ok(map[1].includes(pair), pair);
  }
  assert.match(source, /if \(currentView !== "search"\) searchGroupFilter = SEARCH_SCOPE_BY_VIEW\[currentView\] \?\? "all";/);
});

test('a section scope with no results falls back to all instead of an empty screen', () => {
  assert.match(source, /if \(searchGroupFilter !== "all" && searchGroups\.length && !data\[searchGroupFilter\]\?\.length && !mainSearchState\?\.pending\?\.length\) searchGroupFilter = "all";/);
});
