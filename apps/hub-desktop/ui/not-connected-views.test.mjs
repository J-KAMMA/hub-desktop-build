import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');

test('personal library details show the connect state instead of a failing read', () => {
  const set=app.match(/if \(\[([^\]]+)\]\.includes\(entry\.name\) && desktopAccount\.state !== "registered"\)/)?.[1];
  assert.ok(set);
  for(const name of ['music_library','saved_articles','video_library','video_playlists','music_playlists','article_drafts'])assert.ok(set.includes(`"${name}"`),name);
  // 公開の曲から作るアーティスト一覧は未接続でも読める。
  assert.ok(!set.includes('music_artists'));
  const render=app.slice(app.indexOf('async function renderDetailEntry'));
  const guard=render.indexOf('includes(entry.name) && desktopAccount.state');
  assert.ok(guard>0&&guard<render.indexOf('hub_detail'));
  assert.match(render.slice(guard,guard+260),/ !== "registered"\) \{ target\.replaceChildren\(connectState\(\)\); return; \}/);
});

test('an unconnected notifications view offers the connect action and no error panel', () => {
  const branch=app.match(/value\.phase === "unconnected"\) \{[\s\S]*?\} else state\.textContent = ""/)?.[0];
  assert.ok(branch);
  assert.match(branch,/connectState\(\)/);
});

test('a denied personal ActivityPub read does not blank a public feed', () => {
  assert.match(app,/const personalDenied = activityPub\.status === "rejected" && isReadAccessDenied\(activityPub\.reason\) && \(local\.status === "fulfilled" \|\| external\.status === "fulfilled"\)/);
  assert.match(app,/personalDenied\?null:activityPub/);
});
