import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read = name => readFile(new URL(name, import.meta.url), 'utf8');

// 2026-11-06 所有者の決定でチャンネル（=投稿の種類）が戻った。ただし旧い「チャンネルごとの別テーブル」の動詞・経路・画面は戻さない。
// 今あるのは community_channels（一覧）と community_channel_settings（モデレーターの名前・並び・表示）だけ。
test('the bundled UI no longer names the old channel verbs, paths or screens for communities', async () => {
  const app = await read('./app.js');
  for (const gone of ['channel_message', 'message_reaction', 'community_channel_create', 'community_channel_edit', 'community_channel_up', 'community_channel_down', 'community_channel_delete', 'community_channel_slowmode', 'community_channel_archive', 'channel_messages', 'channelDraft', 'communityChannelControls', '/channels/', 'チャンネル管理', 'communityChannelSection']) {
    assert.equal(app.includes(gone), false, gone);
  }
  const controls = await read('./community-controls.mjs');
  assert.equal(/channel/iu.test(controls), false);
  const composer = await read('./community-post-composer.mjs');
  assert.equal(/channel/iu.test(composer), false);
});

test('the community page reads posts and points through the fixed Rust names', async () => {
  const app = await read('./app.js');
  for (const name of ['community_posts', 'community_posts_kind', 'community_posts_page', 'community_posts_kind_page']) assert.ok(app.includes(`"${name}"`), name);
  const points = await read('./community-points.mjs');
  for (const name of ['community_points_list', 'community_points_list_page', 'community_points_public']) assert.ok(points.includes(`'${name}'`), name);
});
