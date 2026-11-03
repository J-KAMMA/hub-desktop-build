import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read = name => readFile(new URL(name, import.meta.url), 'utf8');

test('the bundled UI no longer names channel verbs, paths or screens for communities', async () => {
  const app = await read('./app.js');
  for (const gone of ['channel_message', 'message_reaction', 'community_channel', 'channel_messages', 'channelDraft', 'communityChannelControls', '/channels/', 'チャンネル管理', 'communityChannelSection']) {
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
