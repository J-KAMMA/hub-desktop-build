import {
  normalizeVideoSource,
  parseExternalVideoInput,
  parseVideoContextInput,
  VIDEO_PURPOSES,
  normalizeMusicSource,
  parseMusicWorkInput,
} from './external-media-contract.mjs';
const shape = (value, required, optional = []) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value, max, required = true) => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\p{Cc}\ud800-\udfff]/u.test(value) ||
    (required && !value.trim())
  )
    throw Error('invalid_text');
  return value;
};
const id = (value, max = 128) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[^A-Za-z0-9_-]/u.test(value);
const uuid = (value) =>
  typeof value === 'string' &&
  value.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const date = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const reportText = (value) => {
  if (typeof value !== 'string' || value.length > 1000 || /[\u0000\ud800-\udfff]/u.test(value))
    throw Error('invalid_report_text');
  return value.trim();
};
const https = (value) => {
  text(value, 2048);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('invalid_url');
  return value;
};
const wire = (value) => {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > 2097152)
    throw Error('response_limit');
  return value;
};
const inputBounds = { sourceUrl: 2048, title: 240, channel: 120, category: 80, topic: 80, relatedHubpediaSlug: 160 };
const musicBounds = { title: 180, artist: 120, description: 500, genre: 60 };
const reportReasons = {
  wrong_metadata: '作品情報が違う',
  unavailable: '再生できない',
  duplicate: '重複している',
  not_music: '音楽ではない',
  rights: '権利上の問題',
  other: 'その他',
};
const purposes = {
  guide: '案内・手順',
  explanation: '解説',
  live: 'ライブ',
  review: 'レビュー',
  creation: '創作',
  music: '音楽',
  other: 'その他',
};
const errors = {
  invalid_request: '入力内容を確認してください。',
  invalid_request_origin: 'この画面から操作できません。',
  suspended: 'この接続では操作できません。',
  not_found: '外部音楽作品が見つかりません。',
  video_exists: 'この動画はすでに登録されています。',
  youtube_video_registration_closed: 'YouTube動画の登録は終了しました。',
  youtube_music_rejected: 'YouTubeの音楽として登録条件を満たしていません。',
};
function rejection(error) {
  const value = String(error?.message ?? error);
  if (value === 'desktop_not_connected') return 'Desktopを接続してください。草稿は保持しています。';
  if (value === 'external_media_rejected:503:youtube_music_validation_unavailable')
    return 'YouTubeの音楽確認サービスを利用できません。入力は保持しています。';
  if (/[\r\n]/u.test(value)) return null;
  const match =
    /^external_media_rejected:(400|403|404|409|410|422):(invalid_request|invalid_request_origin|suspended|not_found|video_exists|youtube_video_registration_closed|youtube_music_rejected)$/u.exec(
      value,
    );
  return match ? errors[match[2]] : null;
}
function videoRecord(value) {
  if (
    !shape(
      value,
      [
        'id',
        'title',
        'channel',
        'category',
        'purpose',
        'topic',
        'provider',
        'sourceUrl',
        'publishedAt',
        'createdAt',
        'viewCount',
      ],
      [
        'submittedByDisplayName',
        'relatedHubpediaSlug',
        'thumbnailUrl',
        'duration',
        'safetyLevel',
        'safetyNotice',
        'availabilityStatus',
        'broadcastStatus',
        'metadataCheckedAt',
      ],
    ) ||
    !id(value.id) ||
    !date(value.createdAt) ||
    !date(value.publishedAt) ||
    !Number.isSafeInteger(value.viewCount) ||
    value.viewCount < 0
  )
    throw Error('invalid_video');
  for (const key of ['title', 'channel', 'category', 'topic']) text(value[key], inputBounds[key]);
  const source = normalizeVideoSource(text(value.sourceUrl, 2048));
  if (value.provider !== source.storedProvider || !VIDEO_PURPOSES.includes(value.purpose)) throw Error('invalid_video');
  if (value.relatedHubpediaSlug !== undefined)
    parseVideoContextInput({
      purpose: value.purpose,
      topic: value.topic,
      relatedHubpediaSlug: text(value.relatedHubpediaSlug, 160, false),
    });
  if (value.thumbnailUrl !== undefined) https(value.thumbnailUrl);
  for (const [key, max] of [
    ['submittedByDisplayName', 200],
    ['duration', 80],
    ['safetyNotice', 1000],
  ])
    if (value[key] !== undefined) text(value[key], max, false);
  if (
    (value.safetyLevel !== undefined &&
      !['standard', 'sensitive', 'adult', 'medical', 'political'].includes(value.safetyLevel)) ||
    (value.availabilityStatus !== undefined &&
      !['unknown', 'available', 'unavailable'].includes(value.availabilityStatus)) ||
    (value.broadcastStatus !== undefined &&
      !['video', 'live', 'upcoming', 'archive'].includes(value.broadcastStatus)) ||
    (value.metadataCheckedAt !== undefined && !date(value.metadataCheckedAt))
  )
    throw Error('invalid_video');
  return value;
}
function musicRecord(value) {
  if (
    !shape(
      value,
      ['id', 'title', 'artist', 'description', 'genre', 'year', 'accent', 'symbol', 'services'],
      ['album', 'tags', 'tagSignals', 'artworkUrl', 'featured', 'source', 'submittedBy', 'createdAt'],
    ) ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 160 ||
    /[\p{Cc}\ud800-\udfff]/u.test(value.id) ||
    !Number.isInteger(value.year) ||
    value.year < 1000 ||
    value.year > new Date().getFullYear() + 1 ||
    !Array.isArray(value.services) ||
    value.services.length > 6
  )
    throw Error('invalid_music');
  for (const [key, max] of Object.entries(musicBounds)) text(value[key], max);
  text(value.accent, 80);
  text(value.symbol, 40);
  if (value.album !== undefined) text(value.album, 180, false);
  if (value.artworkUrl !== undefined) https(value.artworkUrl);
  if (value.submittedBy !== undefined) text(value.submittedBy, 200, false);
  if (
    (value.createdAt !== undefined && !date(value.createdAt)) ||
    (value.source !== undefined && !['community', 'sample'].includes(value.source)) ||
    (value.featured !== undefined && typeof value.featured !== 'boolean')
  )
    throw Error('invalid_music');
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) throw Error('invalid_tags');
    value.tags.forEach((tag) => text(tag, 80));
  }
  if (value.tagSignals !== undefined) {
    if (!Array.isArray(value.tagSignals)) throw Error('invalid_signals');
    for (const signal of value.tagSignals)
      if (
        !shape(signal, ['tag', 'kind', 'confidence', 'source']) ||
        !['genre', 'era', 'language', 'region', 'mood', 'scene', 'tempo', 'feature', 'instrument', 'theme'].includes(
          signal.kind,
        ) ||
        !['metadata', 'rule', 'behavior'].includes(signal.source) ||
        !Number.isFinite(signal.confidence) ||
        signal.confidence < 0 ||
        signal.confidence > 1 ||
        !text(signal.tag, 80)
      )
        throw Error('invalid_signal');
  }
  for (const link of value.services) {
    if (
      !shape(link, ['provider', 'label', 'url'], ['embedUrl']) ||
      !['spotify', 'youtube', 'soundcloud', 'apple', 'amazon', 'bandcamp'].includes(link.provider)
    )
      throw Error('invalid_service');
    text(link.label, 80);
    https(link.url);
    if (link.embedUrl !== undefined) https(link.embedUrl);
  }
  if (new Set(value.services.map((link) => link.provider)).size !== value.services.length)
    throw Error('duplicate_service');
  return value;
}
// A fresh typed public catalog proves only that the list could be read, never who created a row.
export function validateExternalMediaCatalog(kind, value) {
  try {
    wire(value);
    const key = kind === 'video' ? 'videos' : kind === 'music' ? 'works' : null;
    if (
      !key ||
      !shape(
        value,
        [key, 'total'],
        kind === 'video'
          ? ['categories', 'limit', 'offset', 'hasMore']
          : ['nextOffset', 'tagFacets', 'limit', 'offset', 'hasMore', 'matchedBy', 'matchedTags'],
      ) ||
      !Array.isArray(value[key]) ||
      !Number.isSafeInteger(value.total) ||
      value.total < value[key].length
    )
      return false;
    for (const field of ['limit', 'offset', 'nextOffset'])
      if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 0)) return false;
    if (
      (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') ||
      (value.matchedBy !== undefined && !['words', 'tags', 'meaning'].includes(value.matchedBy))
    )
      return false;
    if (value.categories !== undefined) {
      if (!Array.isArray(value.categories)) return false;
      for (const facet of value.categories)
        if (
          !shape(facet, ['name', 'count']) ||
          !text(facet.name, 1000) ||
          !Number.isSafeInteger(facet.count) ||
          facet.count < 0
        )
          return false;
    }
    if (value.tagFacets !== undefined) {
      if (!Array.isArray(value.tagFacets)) return false;
      for (const facet of value.tagFacets)
        if (
          !shape(facet, ['tag', 'kind', 'count']) ||
          !text(facet.tag, 1000) ||
          !text(facet.kind, 80) ||
          !Number.isSafeInteger(facet.count) ||
          facet.count < 0
        )
          return false;
    }
    if (value.matchedTags !== undefined) {
      if (!Array.isArray(value.matchedTags)) return false;
      value.matchedTags.forEach((tag) => text(tag, 1000));
    }
    value[key].forEach(kind === 'video' ? videoRecord : musicRecord);
    return new Set(value[key].map((record) => record.id)).size === value[key].length;
  } catch {
    return false;
  }
}
function ui({ document, getAccount = () => null, isCurrent = () => true, state = {} }, scope) {
  const node = (tag, className, value) => {
    const item = document.createElement(tag);
    item.className = className;
    Object.assign(item.style, { minWidth: '0', maxWidth: '100%', overflowWrap: 'anywhere' });
    if (value !== undefined) item.textContent = value;
    return item;
  };
  const element = node('section', 'external-media-form detail-form card'),
    note = node('p', 'meta');
  note.setAttribute('role', 'status');
  const button = (label, action) => {
    const item = node('button', 'head-action', label);
    item.type = 'button';
    item.dataset.mediaAction = action;
    item.style.whiteSpace = 'normal';
    return item;
  };
  const row = () => {
    const item = node('div', 'actions');
    Object.assign(item.style, { flexWrap: 'wrap', justifyContent: 'flex-start' });
    return item;
  };
  const account = () => {
    try {
      const value = getAccount();
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  };
  const accountKey = account(),
    stamp = { accountKey, ...scope };
  let disposed = false,
    invalid = false,
    viewerId;
  if (state.scope && JSON.stringify(state.scope) !== JSON.stringify(stamp))
    for (const key of Object.keys(state)) delete state[key];
  state.scope = stamp;
  viewerId = state.viewerId;
  note.textContent = typeof state.message === 'string' ? state.message : '';
  const message = (value) => {
    state.message = value;
    note.textContent = value;
  };
  let paint = () => {};
  const live = () => {
    if (!disposed && !invalid && account() !== accountKey) invalidate(true);
    return !disposed && !invalid && isCurrent() && element.isConnected && !element.closest('[hidden]');
  };
  function invalidate(clear = false) {
    invalid = true;
    if (clear) {
      for (const key of Object.keys(state)) delete state[key];
      for (const field of element.querySelectorAll('input,textarea')) field.value = '';
    }
    note.textContent = '接続または画面が変わりました。開き直してください。';
    paint();
  }
  const owner = (next) => {
    if (!id(next) || (viewerId !== undefined && viewerId !== next)) {
      invalidate();
      throw Error('viewer_changed');
    }
    viewerId = next;
    state.viewerId = next;
  };
  const changed = () => invalidate(true);
  document.defaultView?.addEventListener('hub-account-changed', changed);
  return {
    element,
    node,
    note,
    button,
    row,
    message,
    live,
    authorized: () => live() && accountKey !== null,
    owner,
    invalid: () => invalid,
    setPaint: (callback) => {
      paint = callback;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      document.defaultView?.removeEventListener('hub-account-changed', changed);
      element.remove();
    },
  };
}
function rawList(value, max, count) {
  if (typeof value !== 'string') throw Error('invalid_list');
  const list = value.split(/\r?\n/u).filter((row) => row.trim());
  if (list.length > count) throw Error('invalid_list');
  return list.map((row) => text(row, max).trim());
}
function registrationInput(kind, draft) {
  if (kind === 'video') {
    for (const [key, max] of Object.entries(inputBounds)) text(draft[key], max, key !== 'relatedHubpediaSlug');
    if (!VIDEO_PURPOSES.includes(draft.purpose)) throw Error('invalid_purpose');
    const parsed = parseExternalVideoInput(draft),
      context = parseVideoContextInput(draft),
      result = {
        sourceUrl: parsed.source.sourceUrl,
        title: parsed.title,
        channel: parsed.channel,
        category: parsed.category,
        ...context,
      };
    if (result.relatedHubpediaSlug === undefined) delete result.relatedHubpediaSlug;
    for (const [key, max] of Object.entries(inputBounds))
      if (result[key] !== undefined) text(result[key], max, key !== 'relatedHubpediaSlug');
    return result;
  }
  if (kind !== 'music') throw Error('invalid_kind');
  for (const [key, max] of Object.entries(musicBounds)) text(draft[key], max);
  if (
    typeof draft.year !== 'number' ||
    !Number.isInteger(draft.year) ||
    draft.year < 1000 ||
    draft.year > new Date().getFullYear() + 1
  )
    throw Error('invalid_year');
  const serviceUrls = rawList(draft.serviceUrls, 2048, 6),
    tags = draft.tags.trim() ? draft.tags.split(',').map((tag) => text(tag, 40).trim()) : [];
  if (serviceUrls.length < 1 || tags.length > 12) throw Error('invalid_count');
  const parsed = parseMusicWorkInput({ ...draft, serviceUrls, tags });
  const result = {
    title: parsed.title,
    artist: parsed.artist,
    description: parsed.description,
    genre: parsed.genre,
    year: parsed.year,
    tags: parsed.tags,
    serviceUrls: parsed.services.map((service) => service.url),
  };
  for (const [key, max] of Object.entries(musicBounds)) text(result[key], max);
  result.tags.forEach((tag) => text(tag, 40));
  result.serviceUrls.forEach((url) => text(url, 2048));
  return result;
}
export function createExternalMediaRegistration({
  document,
  kind,
  invoke,
  getAccount,
  isCurrent,
  state = {},
  onRegistered = () => {},
  onCheck = async () => false,
}) {
  const c = ui({ document, getAccount, isCurrent, state }, { kind }),
    { element, node, button, row, message } = c;
  const controls = {},
    form = node('form', 'detail-form'),
    preview = node('div', 'card'),
    metadata = node('div', 'card');
  let pending = null,
    revision = 0,
    planned = null,
    checked = false,
    recoveryAsked = false;
  element.append(
    node('h3', '', kind === 'video' ? '外部動画を追加' : '外部音楽作品を追加'),
    node('p', 'meta', '情報を取得しても登録できるとは限りません。提供元のリンクと説明を登録します。'),
  );
  const field = (key, label, multi = false) => {
    const input = node(multi ? 'textarea' : 'input', '');
    input.name = key;
    if (multi) input.rows = key === 'description' ? 3 : 2;
    else input.type = 'text';
    controls[key] = input;
    const wrap = node('label', 'detail-form');
    wrap.append(node('span', 'meta', label), input);
    form.append(wrap);
    return input;
  };
  if (kind === 'video')
    for (const [key, label] of [
      ['sourceUrl', '動画URL'],
      ['title', '題名'],
      ['channel', '投稿元'],
      ['category', 'カテゴリ'],
      ['topic', '話題'],
      ['relatedHubpediaSlug', '関連するHubpedia項目（任意）'],
    ])
      field(key, label).maxLength = inputBounds[key];
  else
    for (const [key, label] of [
      ['serviceUrls', '配信先URL（1行に1件・6件まで）'],
      ['title', '曲名・作品名'],
      ['artist', 'アーティスト'],
      ['description', '説明'],
      ['genre', 'ジャンル'],
      ['tags', 'タグ（カンマ区切り・12件まで）'],
      ['year', 'リリース年'],
    ]) {
      const input = field(key, label, ['serviceUrls', 'description'].includes(key));
      if (musicBounds[key]) input.maxLength = musicBounds[key];
      if (key === 'year') {
        input.type = 'number';
        input.min = '1000';
        input.max = String(new Date().getFullYear() + 1);
        input.step = '1';
      }
    }
  if (kind === 'video') {
    const select = node('select', '');
    select.name = 'purpose';
    controls.purpose = select;
    for (const value of VIDEO_PURPOSES) {
      const option = node('option', '', purposes[value]);
      option.value = value;
      select.append(option);
    }
    const wrap = node('label', 'detail-form');
    wrap.append(node('span', 'meta', '目的'), select);
    form.append(wrap);
  }
  for (const [key, input] of Object.entries(controls))
    input.value = String(
      state.draft?.[key] ?? (key === 'purpose' ? 'other' : key === 'year' ? new Date().getFullYear() : ''),
    );
  const info = button('情報を取得', 'metadata'),
    prepare = button('登録内容を確認', 'preview'),
    confirm = button('確認して登録', 'register'),
    cancel = button('確認を取り消す', 'cancel'),
    check = button('公開一覧を再確認', 'check'),
    resume = button('一覧を確認して新しい操作へ戻る', 'resume'),
    resumeConfirm = button('重複の可能性を確認して戻る', 'resume-confirm'),
    resumeCancel = button('結果確認を続ける', 'resume-cancel');
  const actions = row();
  actions.append(info, prepare, check, resume);
  form.append(actions);
  preview.append(node('p', 'meta', 'この内容を登録します。'), confirm, cancel);
  const recovery = node('div', 'card');
  recovery.append(
    node(
      'p',
      'meta',
      '先の登録が完了している可能性があります。公開一覧を確認しても本人の登録成功は確定しません。新しい操作では重複する可能性があります。',
    ),
    resumeConfirm,
    resumeCancel,
  );
  element.append(form, metadata, preview, recovery, c.note);
  const readDraft = () =>
    Object.fromEntries(
      Object.entries(controls).map(([key, input]) => [key, key === 'year' ? input.valueAsNumber : input.value]),
    );
  function paint() {
    const enabled = ['video', 'music'].includes(kind) && c.authorized(),
      locked = pending === 'write' || !!state.unknown;
    for (const input of Object.values(controls)) input.disabled = !enabled || locked;
    info.disabled = prepare.disabled = !enabled || pending !== null || !!state.unknown;
    confirm.disabled = !enabled || pending !== null || !planned || !!state.unknown;
    cancel.disabled = pending === 'write';
    check.hidden = !state.unknown;
    check.disabled = !enabled || pending !== null;
    resume.hidden = !state.unknown;
    resume.disabled = !enabled || pending !== null || !checked;
    recovery.hidden = !recoveryAsked;
    resumeConfirm.disabled = !enabled || pending !== null || !checked;
    preview.hidden = !planned;
    metadata.hidden = !metadata.childNodes.length;
    element.setAttribute('aria-busy', String(pending !== null));
    if (!enabled && !state.message) c.note.textContent = 'Desktopを接続すると追加できます。';
  }
  c.setPaint(paint);
  if (state.unknown) message('先の操作の結果は未確認です。自動で再送せず、草稿を保持しています。');
  const base = (value, keys) => {
    wire(value);
    if (!shape(value, ['viewerId', ...keys]) || !id(value.viewerId)) throw Error('invalid_receipt');
  };
  async function fetchMetadata() {
    if (!c.authorized() || pending !== null || state.unknown) return;
    let raw, source;
    try {
      raw =
        kind === 'video'
          ? text(controls.sourceUrl.value, 2048).trim()
          : rawList(controls.serviceUrls.value, 2048, 6)[0];
      source = kind === 'video' ? normalizeVideoSource(raw) : normalizeMusicSource(raw);
      text(kind === 'video' ? source.sourceUrl : source.url, 2048);
    } catch {
      message('対応するURLを確認してください。');
      return;
    }
    const turn = revision,
      snapshot = JSON.stringify(readDraft());
    pending = 'metadata';
    message('情報を取得しています…');
    paint();
    try {
      const result = await invoke(kind === 'video' ? 'hub_video_metadata' : 'hub_music_metadata', {
        input: { sourceUrl: raw },
      });
      if (!c.live()) return;
      if (turn !== revision || snapshot !== JSON.stringify(readDraft())) {
        message('入力が変わったため取得情報を反映しませんでした。必要なら再取得してください。');
        return;
      }
      base(result, ['requestedSourceUrl', 'metadata']);
      const value = result.metadata,
        canonical = kind === 'video' ? source.sourceUrl : source.url;
      if (
        result.requestedSourceUrl !== raw ||
        !shape(
          value,
          kind === 'video' ? ['sourceUrl', 'provider'] : ['sourceUrl', 'provider', 'providerLabel'],
          kind === 'video'
            ? ['title', 'channel', 'thumbnailUrl', 'broadcastStatus']
            : ['title', 'artist', 'thumbnailUrl'],
        ) ||
        value.sourceUrl !== canonical ||
        value.provider !== source.provider
      ) {
        throw Error('metadata_mismatch');
      }
      if (kind === 'music') text(value.providerLabel, 80);
      if (value.thumbnailUrl !== undefined) https(value.thumbnailUrl);
      if (
        value.broadcastStatus !== undefined &&
        !['video', 'live', 'upcoming', 'archive'].includes(value.broadcastStatus)
      )
        throw Error('invalid_broadcast');
      for (const key of kind === 'video' ? ['title', 'channel'] : ['title', 'artist'])
        if (value[key] !== undefined) text(value[key], key === 'title' ? (kind === 'video' ? 240 : 180) : 120);
      c.owner(result.viewerId);
      metadata.replaceChildren(
        node('p', 'meta', '取得情報（登録条件の確認ではありません）'),
        node('p', 'detail-p', canonical),
        node('p', 'meta', kind === 'video' ? source.provider : value.providerLabel),
      );
      for (const key of kind === 'video' ? ['title', 'channel'] : ['title', 'artist'])
        if (value[key] !== undefined) {
          metadata.append(node('p', 'detail-p', value[key]));
          if (!controls[key].value.trim()) controls[key].value = value[key];
        }
      state.draft = readDraft();
      planned = null;
      message('取得情報を確認してください。入力済みの内容は保持しています。');
    } catch (error) {
      if (c.live()) message(rejection(error) ?? '情報を取得できませんでした。草稿を確認して再取得してください。');
    } finally {
      pending = null;
      if (c.live()) paint();
    }
  }
  function plan() {
    if (!c.authorized() || pending !== null || state.unknown) return;
    try {
      state.draft = readDraft();
      planned = Object.freeze(registrationInput(kind, state.draft));
      preview.replaceChildren(
        node('p', 'meta', 'この内容を登録します。'),
        ...Object.entries(planned).map(([key, value]) =>
          node(
            'p',
            'detail-p',
            {
              sourceUrl: '提供元URL',
              title: kind === 'video' ? '題名' : '曲名・作品名',
              channel: '投稿元',
              category: 'カテゴリ',
              purpose: '目的',
              topic: '話題',
              relatedHubpediaSlug: '関連Hubpedia項目',
              artist: 'アーティスト',
              description: '説明',
              genre: 'ジャンル',
              year: 'リリース年',
              tags: 'タグ',
              serviceUrls: '配信先URL',
            }[key] +
              ': ' +
              (Array.isArray(value) ? value.join(' / ') : key === 'purpose' ? purposes[value] : value),
          ),
        ),
        confirm,
        cancel,
      );
      message('内容と提供元を確認して登録してください。');
      paint();
    } catch {
      planned = null;
      message('入力内容・文字数・配信先を確認してください。');
      paint();
    }
  }
  async function register() {
    if (!c.authorized() || pending !== null || !planned || state.unknown) return;
    const input = structuredClone(planned),
      turn = revision;
    state.draft = readDraft();
    state.unknown = { input };
    checked = false;
    pending = 'write';
    message('登録結果を確認しています…');
    paint();
    try {
      const result = await invoke(kind === 'video' ? 'hub_video_register' : 'hub_music_register', { input });
      if (!c.live() || turn !== revision) return;
      base(result, [kind === 'video' ? 'video' : 'work']);
      const record = kind === 'video' ? videoRecord(result.video) : musicRecord(result.work);
      if (!uuid(record.id)) throw Error('invalid_id');
      if (
        (kind === 'video' &&
          (record.sourceUrl !== input.sourceUrl ||
            record.provider !== normalizeVideoSource(input.sourceUrl).storedProvider ||
            ['title', 'channel', 'category', 'purpose', 'topic', 'relatedHubpediaSlug'].some(
              (key) => (record[key] ?? '') !== (input[key] ?? ''),
            ))) ||
        (kind === 'music' &&
          (record.source !== 'community' ||
            record.services.length !== input.serviceUrls.length ||
            !input.serviceUrls.every((url) => record.services.some((service) => service.url === url))))
      )
        throw Error('registration_mismatch');
      c.owner(result.viewerId);
      delete state.unknown;
      planned = null;
      // 2026-11-05 所有者「他でもカードか」：タグはジャンルの横の小さな札。
      const facts = node('p', 'meta ar-meta', kind === 'music' ? record.genre : record.channel);
      if (kind === 'music') for (const tag of record.tags ?? []) facts.append(node('span', 'post-tag', '#' + tag));
      metadata.replaceChildren(node('p', 'meta', '登録された表示'), node('p', 'detail-p', record.title), facts);
      message('登録を確認しました。草稿は保持しています。');
      try {
        await onRegistered(record);
      } catch {
        if (c.live()) message('登録は完了しましたが一覧を更新できませんでした。更新してください。');
      }
    } catch (error) {
      if (!c.live()) return;
      const reason = rejection(error);
      if (reason) {
        delete state.unknown;
        message(reason + ' 草稿は保持しています。');
      } else message('登録結果が不明です。再送せず、公開一覧を確認してください。草稿は保持しています。');
    } finally {
      pending = null;
      if (c.live()) paint();
    }
  }
  async function checkList() {
    if (!c.authorized() || pending !== null || !state.unknown) return;
    pending = 'check';
    checked = false;
    paint();
    try {
      const success = await onCheck();
      if (!c.live()) return;
      checked = success === true;
      message(
        checked
          ? '公開一覧を取得しました。先の登録が成功したとは断定できません。内容を確認してください。'
          : '公開一覧を確認できませんでした。結果不明のまま再送しないでください。',
      );
    } catch {
      if (c.live()) message('公開一覧を確認できませんでした。草稿は保持しています。');
    } finally {
      pending = null;
      if (c.live()) paint();
    }
  }
  const click = (event) => {
    const action = event.target.closest?.('[data-media-action]')?.dataset.mediaAction;
    if (!action || !element.contains(event.target) || !c.authorized() || pending !== null) return;
    if (action === 'metadata') void fetchMetadata();
    else if (action === 'preview') plan();
    else if (action === 'register') void register();
    else if (action === 'cancel') {
      planned = null;
      paint();
    } else if (action === 'check') void checkList();
    else if (action === 'resume' && checked) {
      recoveryAsked = true;
      paint();
    } else if (action === 'resume-confirm' && recoveryAsked && checked) {
      delete state.unknown;
      planned = null;
      checked = false;
      recoveryAsked = false;
      message('草稿を保持しています。新しい登録の前に内容を確認してください。');
      paint();
    } else if (action === 'resume-cancel') {
      recoveryAsked = false;
      paint();
    }
  };
  const change = () => {
    if (!c.live() || pending === 'write' || state.unknown) return;
    revision++;
    planned = null;
    metadata.replaceChildren();
    state.draft = readDraft();
    message('草稿を保持しています。');
    paint();
  };
  const submit = (event) => {
    event.preventDefault();
    plan();
  };
  element.addEventListener('click', click);
  form.addEventListener('input', change);
  form.addEventListener('change', change);
  form.addEventListener('submit', submit);
  paint();
  const ready = Promise.resolve().then(() => {
    if (c.live()) paint();
  });
  return {
    element,
    ready,
    destroy() {
      revision++;
      element.removeEventListener('click', click);
      form.removeEventListener('input', change);
      form.removeEventListener('change', change);
      form.removeEventListener('submit', submit);
      c.destroy();
    },
  };
}
export function createExternalMusicReport({ document, workId, invoke, getAccount, isCurrent, state = {} }) {
  const c = ui({ document, getAccount, isCurrent, state }, { workId }),
    { element, node, button, row, message } = c,
    valid = id(workId, 160) && !workId.startsWith('music:') && !workId.startsWith('sample');
  let pending = false,
    planned = null,
    recoveryAsked = false;
  const heading = node('h4', '', '外部音楽作品を報告'),
    reason = node('select', ''),
    details = node('textarea', '');
  reason.name = 'reason';
  details.name = 'details';
  details.maxLength = 1000;
  details.rows = 3;
  for (const [value, label] of Object.entries(reportReasons)) {
    const option = node('option', '', label);
    option.value = value;
    reason.append(option);
  }
  reason.value = Object.hasOwn(reportReasons, state.draft?.reason) ? state.draft.reason : 'wrong_metadata';
  details.value = state.draft?.details ?? '';
  const reasonLabel = node('label', 'detail-form'),
    detailsLabel = node('label', 'detail-form');
  reasonLabel.append(node('span', 'meta', '理由'), reason);
  detailsLabel.append(node('span', 'meta', '補足（任意・1000文字まで）'), details);
  const prepare = button('報告内容を確認', 'report-preview'),
    confirm = button('確認して報告', 'report'),
    cancel = button('確認を取り消す', 'cancel'),
    resume = button('結果不明の報告を確認して編集へ戻る', 'resume'),
    resumeConfirm = button('先の報告が届いた可能性を確認して戻る', 'resume-confirm'),
    resumeCancel = button('結果確認を続ける', 'resume-cancel'),
    preview = node('div', 'card'),
    recovery = node('div', 'card');
  preview.append(confirm, cancel);
  recovery.append(
    node(
      'p',
      'meta',
      '先の報告が届いている可能性があります。ここでは報告結果を確認できません。同じ作品への報告は内容が更新されます。',
    ),
    resumeConfirm,
    resumeCancel,
  );
  const actions = row();
  actions.append(prepare, resume);
  element.append(heading, reasonLabel, detailsLabel, actions, preview, recovery, c.note);
  function paint() {
    const enabled = valid && c.authorized(),
      locked = pending || !!state.unknown;
    reason.disabled = details.disabled = !enabled || locked;
    prepare.disabled = !enabled || locked;
    confirm.disabled = !enabled || pending || !planned || !!state.unknown;
    preview.hidden = !planned;
    resume.hidden = !state.unknown;
    resume.disabled = !enabled || pending;
    recovery.hidden = !recoveryAsked;
    resumeConfirm.disabled = !enabled || pending;
    element.setAttribute('aria-busy', String(pending));
    if (!enabled && !state.message)
      c.note.textContent = valid
        ? 'Desktopを接続すると報告できます。'
        : 'この作品はHub外部作品の報告対象ではありません。';
  }
  c.setPaint(paint);
  if (state.unknown) message('先の操作の結果は未確認です。自動で再送せず、草稿を保持しています。');
  const draft = () => ({ reason: reason.value, details: details.value });
  const click = (event) => {
    const action = event.target.closest?.('[data-media-action]')?.dataset.mediaAction;
    if (!action || !element.contains(event.target) || !valid || !c.authorized() || pending) return;
    if (action === 'report-preview' && !state.unknown) {
      try {
        state.draft = draft();
        if (!Object.hasOwn(reportReasons, reason.value)) throw Error('invalid_reason');
        planned = Object.freeze({ workId, reason: reason.value, details: reportText(details.value) });
        preview.replaceChildren(
          node('p', 'meta', reportReasons[planned.reason]),
          node('p', 'detail-p', planned.details),
          confirm,
          cancel,
        );
        message('報告内容を確認してください。');
        paint();
      } catch {
        message('理由と補足の文字数を確認してください。');
      }
    } else if (action === 'report' && planned && !state.unknown) void save();
    else if (action === 'cancel') {
      planned = null;
      paint();
    } else if (action === 'resume') {
      recoveryAsked = true;
      paint();
    } else if (action === 'resume-confirm' && recoveryAsked) {
      delete state.unknown;
      planned = null;
      recoveryAsked = false;
      message('草稿を保持しています。もう一度報告する場合は内容を確認してください。');
      paint();
    } else if (action === 'resume-cancel') {
      recoveryAsked = false;
      paint();
    }
  };
  async function save() {
    const input = { ...planned };
    pending = true;
    state.unknown = { input };
    message('報告結果を確認しています…');
    paint();
    try {
      const result = await invoke('hub_music_report', { input });
      if (!c.live()) return;
      wire(result);
      if (!shape(result, ['viewerId', 'workId', 'reported']) || result.workId !== workId || result.reported !== true)
        throw Error('invalid_receipt');
      c.owner(result.viewerId);
      delete state.unknown;
      planned = null;
      message('報告を受け付けました。');
    } catch (error) {
      if (c.live()) {
        const known = rejection(error);
        if (known) delete state.unknown;
        message(known ?? '報告結果が不明です。自動で再送せず草稿を保持しています。');
      }
    } finally {
      pending = false;
      if (c.live()) paint();
    }
  }
  const change = () => {
    if (!c.live() || pending || state.unknown) return;
    state.draft = draft();
    planned = null;
    message('草稿を保持しています。');
    paint();
  };
  element.addEventListener('click', click);
  element.addEventListener('input', change);
  element.addEventListener('change', change);
  paint();
  const ready = Promise.resolve().then(() => {
    if (c.live()) paint();
  });
  return {
    element,
    ready,
    destroy() {
      element.removeEventListener('click', click);
      element.removeEventListener('input', change);
      element.removeEventListener('change', change);
      c.destroy();
    },
  };
}
