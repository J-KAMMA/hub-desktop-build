import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  createExternalMediaRegistration,
  createExternalMusicReport,
  validateExternalMediaCatalog,
} from './external-media-registration.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const time = '2026-10-06T01:00:00.000Z',
  vimeo = 'https://vimeo.com/76979871',
  youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  uuid = 'a1111111-1111-4111-8111-111111111111';
const video = (values = {}) => ({
  id: uuid,
  title: '題名',
  channel: '投稿元',
  category: '映像',
  purpose: 'other',
  topic: '話題',
  provider: 'vimeo',
  sourceUrl: vimeo,
  publishedAt: time,
  createdAt: time,
  viewCount: 0,
  ...values,
});
const music = (values = {}) => ({
  id: uuid,
  title: '作品',
  artist: '音楽家',
  description: '説明',
  genre: 'ロック',
  year: 2026,
  tags: ['ロック'],
  tagSignals: [],
  accent: 'semantic-unused',
  symbol: '♪',
  source: 'community',
  submittedBy: '表示名',
  createdAt: time,
  services: [
    {
      provider: 'youtube',
      label: 'YouTube Music',
      url: youtube,
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    },
  ],
  ...values,
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function fixture(
  t,
  {
    kind = 'video',
    report = false,
    workId = 'external-work',
    guest = false,
    state = {},
    handlers = {},
    onCheck = async () => false,
  } = {},
) {
  const dom = new JSDOM('<main></main>'),
    document = dom.window.document,
    calls = [],
    registered = [];
  let account = guest ? null : 'g1',
    current = true;
  const backend = {
    hub_video_metadata: (args) => ({
      viewerId: 'v1',
      requestedSourceUrl: args.input.sourceUrl,
      metadata: { sourceUrl: vimeo, provider: 'Vimeo', title: '取得した題名', channel: '取得元' },
    }),
    hub_music_metadata: (args) => ({
      viewerId: 'v1',
      requestedSourceUrl: args.input.sourceUrl,
      metadata: {
        sourceUrl: youtube,
        provider: 'youtube',
        providerLabel: 'YouTube',
        title: '取得した作品',
        artist: '取得元',
      },
    }),
    hub_video_register: (args) => ({ viewerId: 'v1', video: video({ ...args.input }) }),
    hub_music_register: (args) => ({ viewerId: 'v1', work: music({ ...args.input, services: music().services }) }),
    hub_music_report: (args) => ({ viewerId: 'v1', workId: args.input.workId, reported: true }),
    ...handlers,
  };
  const options = {
    document,
    kind,
    workId,
    state,
    getAccount: () => account,
    isCurrent: () => current,
    invoke: async (name, args) => {
      calls.push([name, structuredClone(args)]);
      return backend[name](args);
    },
    onRegistered: (record) => {
      registered.push(record);
    },
    onCheck,
  };
  let widget = (report ? createExternalMusicReport : createExternalMediaRegistration)(options);
  document.querySelector('main').append(widget.element);
  await widget.ready;
  t.after(() => {
    widget.destroy();
    dom.window.close();
  });
  const button = (action) => widget.element.querySelector('[data-media-action="' + action + '"]'),
    input = (name) => widget.element.querySelector('[name="' + name + '"]'),
    change = (name, value) => {
      input(name).value = value;
      input(name).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
  const populate = () => {
    if (report) {
      change('details', '補足');
      return;
    }
    if (kind === 'video')
      for (const [key, value] of Object.entries({
        sourceUrl: vimeo,
        title: '題名',
        channel: '投稿元',
        category: '映像',
        topic: '話題',
      }))
        change(key, value);
    else
      for (const [key, value] of Object.entries({
        serviceUrls: youtube,
        title: '作品',
        artist: '音楽家',
        description: '説明',
        genre: 'rock',
        year: '2026',
        tags: 'tag',
      }))
        change(key, value);
  };
  return {
    dom,
    document,
    calls,
    registered,
    state,
    backend,
    button,
    input,
    change,
    populate,
    get widget() {
      return widget;
    },
    setAccount: (value) => {
      account = value;
    },
    setCurrent: (value) => {
      current = value;
    },
    async remount() {
      widget.destroy();
      widget = (report ? createExternalMusicReport : createExternalMediaRegistration)(options);
      document.querySelector('main').append(widget.element);
      await widget.ready;
    },
  };
}
const writes = (f) => f.calls.filter(([name]) => !name.endsWith('metadata'));
test('registration has no eager IPC, validates canonical preview, explicit confirm sends once and preserves draft', async (t) => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0);
  f.populate();
  f.button('preview').click();
  assert.equal(f.calls.length, 0);
  assert.equal(f.button('register').disabled, false);
  f.button('register').click();
  f.button('register').click();
  await settle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], [
    'hub_video_register',
    {
      input: { sourceUrl: vimeo, title: '題名', channel: '投稿元', category: '映像', purpose: 'other', topic: '話題' },
    },
  ]);
  assert.equal(f.registered.length, 1);
  assert.equal(f.state.draft.title, '題名');
  assert.match(f.widget.element.textContent, /登録された表示/);
});
test('metadata requested rawtrim and canonical URL are checked; only blank fields fill and optional info is safely displayed', async (t) => {
  const f = await fixture(t);
  f.change('sourceUrl', ' ' + vimeo + ' ');
  f.change('title', '手入力');
  f.button('metadata').click();
  await settle();
  assert.equal(f.calls[0][1].input.sourceUrl, vimeo);
  assert.equal(f.input('title').value, '手入力');
  assert.equal(f.input('channel').value, '取得元');
  assert.match(f.widget.element.textContent, /登録条件の確認ではありません/);
  assert.equal(f.registered.length, 0);
});
test('URL and manually edited field changes discard late metadata without overwriting or registering', async (t) => {
  for (const [key, value] of [
    ['sourceUrl', 'https://vimeo.com/11111111'],
    ['title', '後から編集'],
    ['category', '変更'],
  ]) {
    const delayed = gate(),
      f = await fixture(t, { handlers: { hub_video_metadata: () => delayed.promise } });
    f.change('sourceUrl', vimeo);
    f.button('metadata').click();
    f.change(key, value);
    delayed.resolve({
      viewerId: 'v1',
      requestedSourceUrl: vimeo,
      metadata: { sourceUrl: vimeo, provider: 'Vimeo', title: '旧題名', channel: '旧投稿元' },
    });
    await settle();
    assert.equal(f.input(key).value, value);
    assert.notEqual(f.input('channel').value, '旧投稿元');
    assert.match(f.widget.element.textContent, /入力が変わった/);
  }
});
test('metadata invalid source, echo, provider, payload limit or surrogate is rejected without copying fields', async (t) => {
  for (const patch of [
    { requestedSourceUrl: vimeo + '?different' },
    { metadata: { sourceUrl: 'https://vimeo.com/11111111', provider: 'Vimeo', title: '不正' } },
    { metadata: { sourceUrl: vimeo, provider: 'youtube', title: '不正' } },
    { metadata: { sourceUrl: vimeo, provider: 'Vimeo', title: '\ud800' } },
    { metadata: { sourceUrl: vimeo, provider: 'Vimeo', title: 'x'.repeat(2097152) } },
  ]) {
    const f = await fixture(t, {
      handlers: {
        hub_video_metadata: () => ({
          viewerId: 'v1',
          requestedSourceUrl: vimeo,
          metadata: { sourceUrl: vimeo, provider: 'Vimeo' },
          ...patch,
        }),
      },
    });
    f.change('sourceUrl', vimeo);
    f.button('metadata').click();
    await settle();
    assert.equal(f.input('title').value, '');
    assert.equal(f.registered.length, 0);
  }
});
test('music metadata succeeds without implying registration eligibility; canonicalized genre/tags remain valid receipt', async (t) => {
  const f = await fixture(t, { kind: 'music' });
  f.populate();
  f.button('metadata').click();
  await settle();
  assert.equal(f.input('artist').value, '音楽家');
  f.backend.hub_music_register = () => ({
    viewerId: 'v1',
    work: music({ title: '登録時の表示名', genre: 'ロック', tags: ['ロック', '2020年代'] }),
  });
  f.button('preview').click();
  f.button('register').click();
  await settle();
  assert.equal(f.registered.length, 1);
  assert.match(f.widget.element.textContent, /登録時の表示名/);
  assert.equal(f.calls[1][1].input.year, 2026);
  assert.equal(typeof f.calls[1][1].input.year, 'number');
  assert.equal(f.state.draft.genre, 'rock');
});
test('music registration accepts and displays seventeen typed inferred output tags while raw input still has one tag', async (t) => {
  const tags = Array.from({ length: 17 }, (_, index) => '派生タグ' + index),
    f = await fixture(t, {
      kind: 'music',
      handlers: { hub_music_register: () => ({ viewerId: 'v1', work: music({ tags }) }) },
    });
  f.populate();
  f.button('preview').click();
  f.button('register').click();
  await settle();
  assert.equal(f.registered.length, 1);
  assert.deepEqual(f.registered[0].tags, tags);
  assert.equal(f.state.unknown, undefined);
  assert.deepEqual(writes(f)[0][1].input.tags, ['tag']);
  assert.match(f.widget.element.textContent, /登録された表示/);
  assert.match(f.widget.element.textContent, /派生タグ16/);
});
test('fresh typed public catalog with seventeen inferred tags permits explicit unknown-registration recovery', async (t) => {
  const tags = Array.from({ length: 17 }, (_, index) => '派生タグ' + index),
    page = { works: [music({ tags })], total: 1 };
  let reads = 0;
  const f = await fixture(t, {
    kind: 'music',
    handlers: {
      hub_music_register: () => {
        throw Error('unknown');
      },
    },
    onCheck: async () => {
      reads++;
      return validateExternalMediaCatalog('music', page);
    },
  });
  f.populate();
  f.button('preview').click();
  f.button('register').click();
  await settle();
  assert.ok(f.state.unknown);
  f.button('check').click();
  await settle();
  assert.equal(reads, 1);
  assert.equal(f.button('resume').disabled, false);
  assert.match(f.widget.element.textContent, /成功したとは断定できません/);
  f.button('resume').click();
  f.button('resume-confirm').click();
  assert.equal(f.state.unknown, undefined);
  assert.equal(writes(f).length, 1);
  assert.equal(f.input('tags').value, 'tag');
  assert.equal(
    validateExternalMediaCatalog('music', { works: [music({ tags: [...tags, '\ud800'] })], total: 1 }),
    false,
  );
  assert.equal(
    validateExternalMediaCatalog('music', { works: [music({ tags: [...tags, 'x'.repeat(81)] })], total: 1 }),
    false,
  );
});
test('raw UTF16 limits and normalization expansion reject before IPC while exact emoji boundary works', async (t) => {
  for (const [key, value] of [
    ['title', 'x'.repeat(241)],
    ['channel', 'x'.repeat(121)],
    ['topic', 'x'.repeat(81)],
    ['relatedHubpediaSlug', 'a'.repeat(161)],
    ['title', 'ﬃ'.repeat(81)],
    ['title', '\udfff'],
    ['title', 'bad\0'],
    ['channel', 'bad\t'],
  ]) {
    const f = await fixture(t);
    f.populate();
    f.change(key, value);
    f.button('preview').click();
    f.button('register').click();
    await settle();
    assert.equal(writes(f).length, 0);
    assert.equal(f.state.draft[key], value);
  }
  const f = await fixture(t);
  f.populate();
  f.change('title', '😀'.repeat(120));
  f.button('preview').click();
  f.button('register').click();
  await settle();
  assert.equal(writes(f).length, 1);
});
test('music year, URL counts, tags counts and per-field raw lengths are checked before shared parser conversion', async (t) => {
  for (const [key, value] of [
    ['year', '2026.5'],
    ['year', '999'],
    ['year', String(new Date().getFullYear() + 2)],
    ['artist', 'x'.repeat(121)],
    ['description', 'x'.repeat(501)],
    ['tags', Array(13).fill('tag').join(',')],
    ['tags', 'x'.repeat(41)],
    ['serviceUrls', Array(7).fill(youtube).join('\n')],
    ['serviceUrls', youtube + '\n' + youtube],
    ['serviceUrls', 'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['serviceUrls', 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl'],
  ]) {
    const f = await fixture(t, { kind: 'music' });
    f.populate();
    f.change(key, value);
    f.button('preview').click();
    f.button('register').click();
    await settle();
    assert.equal(writes(f).length, 0);
  }
});
test('guest and invalid kind never send metadata or registration', async (t) => {
  for (const options of [{ guest: true }, { kind: 'other' }]) {
    const f = await fixture(t, options);
    f.button('metadata').click();
    f.button('preview').click();
    f.button('register').click();
    await settle();
    assert.equal(f.calls.length, 0);
  }
});
test('unknown registration preserves input, requires fresh true catalog check and two-step deliberate recovery', async (t) => {
  let checked = false;
  const f = await fixture(t, {
    onCheck: async () => checked,
    handlers: {
      hub_video_register: () => {
        throw Error('external_media_unavailable');
      },
    },
  });
  f.populate();
  f.button('preview').click();
  f.button('register').click();
  await settle();
  assert.equal(writes(f).length, 1);
  assert.ok(f.state.unknown);
  assert.equal(f.input('title').disabled, true);
  f.button('register').click();
  await f.remount();
  assert.equal(writes(f).length, 1);
  f.button('check').click();
  await settle();
  assert.equal(f.button('resume').disabled, true);
  checked = true;
  f.button('check').click();
  await settle();
  assert.equal(f.button('resume').disabled, false);
  assert.match(f.widget.element.textContent, /成功したとは断定できません/);
  f.button('resume').click();
  assert.ok(f.state.unknown);
  f.button('resume-confirm').click();
  assert.equal(f.state.unknown, undefined);
  assert.equal(f.input('title').value, '題名');
  assert.equal(writes(f).length, 1);
});
test('void/caught public check and failed recheck cannot release an earlier recovery confirmation', async (t) => {
  let result;
  const f = await fixture(t, {
    onCheck: async () => result,
    handlers: {
      hub_video_register: () => {
        throw Error('unknown');
      },
    },
  });
  f.populate();
  f.button('preview').click();
  f.button('register').click();
  await settle();
  f.button('check').click();
  await settle();
  assert.equal(f.button('resume').disabled, true);
  result = true;
  f.button('check').click();
  await settle();
  f.button('resume').click();
  result = false;
  f.button('check').click();
  await settle();
  f.button('resume-confirm').click();
  assert.ok(f.state.unknown);
  assert.equal(writes(f).length, 1);
});
test('known 409/410/422 fail safely without unknown freeze and preserve draft for explicit correction', async (t) => {
  for (const error of [
    'external_media_rejected:409:video_exists',
    'external_media_rejected:410:youtube_video_registration_closed',
    'external_media_rejected:422:youtube_music_rejected',
    'desktop_not_connected',
  ]) {
    const f = await fixture(t, {
      handlers: {
        hub_video_register: () => {
          throw error;
        },
      },
    });
    f.populate();
    f.button('preview').click();
    f.button('register').click();
    await settle();
    assert.equal(f.state.unknown, undefined);
    assert.equal(f.input('title').value, '題名');
    assert.equal(f.registered.length, 0);
    assert.equal(writes(f).length, 1);
  }
});
test('definite pre-create YouTube validation 503 keeps music draft editable without unknown loop or automatic retry', async (t) => {
  const f = await fixture(t, {
    kind: 'music',
    handlers: {
      hub_music_register: () => {
        throw Error('external_media_rejected:503:youtube_music_validation_unavailable');
      },
    },
  });
  f.populate();
  f.button('preview').click();
  f.button('register').click();
  await settle();
  assert.equal(f.state.unknown, undefined);
  assert.equal(f.input('title').value, '作品');
  assert.equal(f.input('artist').disabled, false);
  assert.equal(f.button('check').hidden, true);
  assert.match(f.widget.element.textContent, /音楽確認サービスを利用できません/);
  assert.equal(writes(f).length, 1);
  await f.remount();
  assert.equal(writes(f).length, 1);
  assert.equal(f.state.draft.title, '作品');
});
test('account/view/destroy discard late response; account change clears draft and never recurses', async (t) => {
  for (const mode of ['account', 'view', 'destroy']) {
    const delayed = gate(),
      f = await fixture(t, { handlers: { hub_video_metadata: () => delayed.promise } });
    f.change('sourceUrl', vimeo);
    f.button('metadata').click();
    if (mode === 'account') {
      f.setAccount('g2');
      f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));
      assert.equal(f.state.draft, undefined);
    } else if (mode === 'view') f.setCurrent(false);
    else f.widget.destroy();
    delayed.resolve({
      viewerId: 'v1',
      requestedSourceUrl: vimeo,
      metadata: { sourceUrl: vimeo, provider: 'Vimeo', title: '古い応答' },
    });
    await settle();
    assert.equal(f.registered.length, 0);
    if (mode !== 'destroy') assert.notEqual(f.input('title').value, '古い応答');
  }
});
test('pinned viewer or registered canonical source mismatch cannot claim success or overwrite another scope', async (t) => {
  for (const patch of [
    { viewerId: 'v2' },
    { video: video({ sourceUrl: 'https://vimeo.com/11111111' }) },
    { video: video({ id: 'not-uuid' }) },
  ]) {
    const f = await fixture(t);
    f.populate();
    f.button('metadata').click();
    await settle();
    f.backend.hub_video_register = () => ({ viewerId: 'v1', video: video(), ...patch });
    f.button('preview').click();
    f.button('register').click();
    await settle();
    assert.equal(f.registered.length, 0);
    assert.ok(f.state.unknown);
  }
});
test('public catalog check accepts typed empty/normal data but rejects malformed, oversized or unrelated envelopes', () => {
  assert.equal(validateExternalMediaCatalog('video', { videos: [], total: 0 }), true);
  assert.equal(validateExternalMediaCatalog('music', { works: [music()], total: 1 }), true);
  assert.equal(validateExternalMediaCatalog('video', { videos: [video()], total: 1 }), true);
  assert.equal(validateExternalMediaCatalog('video', { works: [] }), false);
  assert.equal(validateExternalMediaCatalog('music', { works: [music({ year: '2026' })], total: 1 }), false);
  assert.equal(validateExternalMediaCatalog('video', { videos: [], extra: 'x'.repeat(2097152) }), false);
});
test('external work report requires preview, sends closed fields only, double click one request', async (t) => {
  const f = await fixture(t, { report: true });
  f.populate();
  f.button('report-preview').click();
  assert.equal(f.calls.length, 0);
  f.button('report').click();
  f.button('report').click();
  await settle();
  assert.deepEqual(f.calls, [
    ['hub_music_report', { input: { workId: 'external-work', reason: 'wrong_metadata', details: '補足' } }],
  ]);
  assert.match(f.widget.element.textContent, /報告を受け付け/);
});
test('Music original, sample, guest and invalid work IDs have no report mutation', async (t) => {
  for (const options of [
    { workId: 'music:' + uuid },
    { workId: 'sample-work' },
    { workId: 'bad\n' },
    { workId: 'x'.repeat(161) },
    { guest: true },
  ]) {
    const f = await fixture(t, { report: true, ...options });
    f.button('report-preview').click();
    f.button('report').click();
    await settle();
    assert.equal(f.calls.length, 0);
  }
});
test('report UTF16 bounds, control/surrogate rejection and unknown draft recovery remain explicit', async (t) => {
  for (const details of ['x'.repeat(1001), '\ud800', '\udfff', 'bad\0']) {
    const f = await fixture(t, { report: true });
    f.change('details', details);
    f.button('report-preview').click();
    f.button('report').click();
    await settle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.draft.details, details);
  }
  const f = await fixture(t, {
    report: true,
    handlers: {
      hub_music_report: () => {
        throw Error('unknown');
      },
    },
  });
  f.change('details', '😀'.repeat(500));
  f.button('report-preview').click();
  f.button('report').click();
  await settle();
  assert.equal(f.calls.length, 1);
  await f.remount();
  f.button('resume').click();
  assert.ok(f.state.unknown);
  f.button('resume-confirm').click();
  assert.equal(f.state.unknown, undefined);
  assert.equal(f.input('details').value.length, 1000);
  assert.equal(f.calls.length, 1);
});
test('report mismatched target, actor and stale account never display success', async (t) => {
  const f = await fixture(t, {
    report: true,
    handlers: { hub_music_report: () => ({ viewerId: 'v1', workId: 'other', reported: true }) },
  });
  f.populate();
  f.button('report-preview').click();
  f.button('report').click();
  await settle();
  assert.ok(f.state.unknown);
  assert.doesNotMatch(f.widget.element.textContent, /報告を受け付け/);
  const delayed = gate(),
    g = await fixture(t, { report: true, handlers: { hub_music_report: () => delayed.promise } });
  g.populate();
  g.button('report-preview').click();
  g.button('report').click();
  g.setAccount('g2');
  delayed.resolve({ viewerId: 'v1', workId: 'external-work', reported: true });
  await settle();
  assert.equal(g.state.unknown, undefined);
  assert.doesNotMatch(g.widget.element.textContent, /報告を受け付け/);
});
test('report multiline/tab detail is preserved exactly through preview and post while NUL still fails', async (t) => {
  const f = await fixture(t, { report: true }),
    value = '最初の行\n\t次の行';
  f.change('details', value);
  f.button('report-preview').click();
  assert.match(f.widget.element.textContent, /最初の行\n\t次の行/);
  f.button('report').click();
  await settle();
  assert.equal(f.calls[0][1].input.details, value);
  const g = await fixture(t, { report: true });
  g.change('details', '最初の行\n\0次の行');
  g.button('report-preview').click();
  g.button('report').click();
  await settle();
  assert.equal(g.calls.length, 0);
});
test('in-flight registration is kept unknown on same-view remount and old ACK cannot affect the new form', async (t) => {
  const delayed = gate(),
    f = await fixture(t, { handlers: { hub_video_register: () => delayed.promise } });
  f.populate();
  f.button('preview').click();
  f.button('register').click();
  await f.remount();
  delayed.resolve({ viewerId: 'v1', video: video() });
  await settle();
  assert.equal(f.registered.length, 0);
  assert.ok(f.state.unknown);
  assert.match(f.widget.element.textContent, /未確認/);
  assert.equal(f.input('title').value, '題名');
  assert.equal(f.calls.length, 1);
});
test('report actor remains pinned across redraw, changed actor cannot turn a second receipt into success', async (t) => {
  const f = await fixture(t, { report: true });
  f.populate();
  f.button('report-preview').click();
  f.button('report').click();
  await settle();
  await f.remount();
  f.change('details', '更新');
  f.backend.hub_music_report = () => ({ viewerId: 'v2', workId: 'external-work', reported: true });
  f.button('report-preview').click();
  f.button('report').click();
  await settle();
  assert.match(f.widget.element.textContent, /接続または画面/);
  assert.equal(f.state.viewerId, 'v1');
  assert.ok(f.state.unknown);
});
test('actual app adds one small entry per existing view, uses typed catalog check and preserves existing controls', async (t) => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8'),
    html = readFileSync(new URL('./index.html',import.meta.url), 'utf8'),
    dom = new JSDOM(html),
    document = dom.window.document;
  const block = source.slice(source.indexOf('const externalMediaDrafts='), source.indexOf('let threadBoardKey ='));
  const calls = [],
    refreshes = [];
  let publicPage = { videos: [video()], total: 1 };
  const invoke = async (name, args) => {
    calls.push([name, structuredClone(args)]);
    if (name === 'hub_resource') return publicPage;
    if (name === 'hub_video_register') throw Error('unknown');
    throw Error('unexpected');
  };
  const api = new Function(
    'document',
    'window',
    'createExternalMediaRegistration',
    'validateExternalMediaCatalog',
    'invoke',
    'loadCatalog',
    "let currentView='videos',researchAccountGeneration=1,desktopAccount={state:'registered'};" +
      block +
      'return{open:mountExternalMediaRegistration,dispose:disposeExternalMediaRegistration,state:externalMediaDrafts,again:initExternalMediaRegistrationEntries,setView(value){disposeExternalMediaRegistration();currentView=value;}};',
  )(document, dom.window, createExternalMediaRegistration, validateExternalMediaCatalog, invoke, (view) =>
    refreshes.push(view),
  );
  t.after(() => {
    api.dispose();
    dom.window.close();
  });
  api.again();
  assert.equal(document.querySelectorAll('#video-add-external').length, 1);
  assert.equal(document.querySelectorAll('#music-add-external').length, 1);
  assert.ok(document.querySelector('#video-search'));
  assert.ok(document.querySelector('#music-tab-tracks'));
  document.getElementById('video-add-external').click();
  await settle();
  const host = document.querySelector('.external-media-form'),
    input = (name) => host.querySelector('[name="' + name + '"]'),
    button = (action) => host.querySelector('[data-media-action="' + action + '"]');
  for (const [key, value] of Object.entries({
    sourceUrl: vimeo,
    title: '題名',
    channel: '投稿元',
    category: '映像',
    topic: '話題',
  })) {
    input(key).value = value;
    input(key).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  button('preview').click();
  button('register').click();
  await settle();
  button('check').click();
  await settle();
  assert.equal(button('resume').disabled, false);
  assert.match(host.querySelector('[data-media-catalog-snapshot]').textContent, /題名/);
  assert.equal(refreshes.length, 0);
  publicPage = { videos: [], error: 'failed' };
  button('check').click();
  await settle();
  assert.equal(button('resume').disabled, true);
  api.setView('music');
  document.getElementById('music-add-external').click();
  await settle();
  assert.equal(host.isConnected, false);
  assert.equal(document.querySelectorAll('.external-media-form').length, 1);
  assert.match(document.querySelector('.external-media-form').textContent, /外部音楽作品/);
  dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));
  assert.deepEqual(api.state.video, {});
  assert.deepEqual(api.state.music, {});
});
test('the rail work page reports only Hub community external work: the ⋯ menu item is disabled for every other work and the form keeps its draft per work', async (t) => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
    dom = new JSDOM('<main></main>'),
    document = dom.window.document;
  t.after(() => dom.window.close());
  const line = source.slice(source.indexOf('const reportableMusicWork = '), source.indexOf('\n', source.indexOf('const reportableMusicWork = ')));
  const reportable = new Function(line + '; return reportableMusicWork;')();
  assert.equal(reportable(music()), true);
  for (const record of [music({ source: 'sample' }), music({ id: 'music:' + uuid }), music({ id: 'sample-1' }), null, {}]) assert.equal(reportable(record), false);
  // 右列の作品ページに出す報告の形（折りたたみ・作品ごとの下書き）を実コードのまま確かめる。
  const wiring = source.slice(source.indexOf('      report: ({ host, work, isCurrent, open }) => {'), source.indexOf('      download: (work)'));
  const run = new Function('document', 'createExternalMusicReport', 'reportableMusicWork', 'accountOptions', 'desktopAccount', 'researchAccountGeneration', 'railMusicReportDrafts',
    'const deps={' + wiring.replace(/,\s*$/, '') + '}; return deps.report;');
  const drafts = new Map();
  const report = run(document, createExternalMusicReport, reportable, () => ({ generation: 1, invoke: async () => { throw Error('unused'); } }), { state: 'registered' }, 1, drafts);
  const host = document.querySelector('main');
  const handle = report({ host, work: music(), isCurrent: () => true, open: true });
  await handle.ready;
  assert.equal(host.querySelector('details').open, true);
  assert.match(host.textContent, /作品を報告/);
  assert.ok(drafts.get(uuid), 'the draft state belongs to the work');
  handle.destroy();
  assert.equal(report({ host, work: music({ id: 'music:' + uuid }), isCurrent: () => true, open: false }), null);
});
