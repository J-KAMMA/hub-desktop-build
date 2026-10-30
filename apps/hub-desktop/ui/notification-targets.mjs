// Local descriptors only. No navigation, IPC, or arbitrary URL execution.
const invalidText = value => /[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const id = (value, max = 128) => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[^A-Za-z0-9_-]/u.test(value);
const doc = value => typeof value === 'string' && value.length >= 1 && value.length <= 100 && !/[^A-Za-z0-9_.-]/u.test(value);
const project = value => typeof value === 'string' && value.length === 35 && /^rp_[a-f0-9]+$/u.test(value);
const uuid = value => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const messageId = value => typeof value === 'string' && value.length >= 1 && value.length <= 80
  && (!/[^A-Za-z0-9_-]/u.test(value) || (value.length === 46 && /^scheduled:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)));
const positive = value => typeof value === 'string' && value.length <= 16 && /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value));
const detail = (name, ids, title, state = {}) => ({ kind: 'detail', name, ids, title, ...(Object.keys(state).length ? { state } : {}) });
const view = name => ({ kind: 'view', view: name });
const ownValue = (object, key) => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;

function components(path) {
  if (typeof path !== 'string' || !path.length || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || invalidText(path)) return null;
  // Historical dedupe suffix is metadata, never a route or an executable fragment.
  const event = path.indexOf('#event=');
  if (event >= 0) {
    if (path.indexOf('#event=', event + 1) >= 0) return null;
    const raw = path.slice(event + 7);
    let key; try { key = decodeURIComponent(raw); } catch { return null; }
    if (!key || key.length > 160 || raw.includes('#') || invalidText(key)) return null;
    path = path.slice(0, event);
  }
  const hashAt = path.indexOf('#'), fragmentRaw = hashAt < 0 ? '' : path.slice(hashAt + 1);
  if (fragmentRaw.includes('#') || (hashAt >= 0 && !fragmentRaw)) return null;
  const beforeHash = hashAt < 0 ? path : path.slice(0, hashAt), queryAt = beforeHash.indexOf('?');
  const pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt), queryRaw = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1);
  if (queryAt >= 0 && !queryRaw) return null;
  let segments, fragment;
  try {
    segments = pathname.slice(1).split('/').map(value => decodeURIComponent(value));
    fragment = decodeURIComponent(fragmentRaw);
  } catch { return null; }
  if (segments.at(-1) === '') segments.pop();
  if (segments.some(value => !value || value === '.' || value === '..' || /[/\\?#%]/u.test(value) || invalidText(value)) || invalidText(fragment)) return null;
  if (segments[0] === 'v2') segments.shift();
  const query = new Map();
  for (const pair of queryRaw ? queryRaw.split('&') : []) {
    const equals = pair.indexOf('='); if (equals < 1) return null;
    let key, value;
    try { key = decodeURIComponent(pair.slice(0, equals).replace(/\+/gu, ' ')); value = decodeURIComponent(pair.slice(equals + 1).replace(/\+/gu, ' ')); } catch { return null; }
    if (!value || invalidText(key) || invalidText(value) || query.has(key)) return null;
    query.set(key, value);
  }
  return { segments, query, fragment };
}

/** Closed target grammar for existing Hub paths; null keeps the caller's unavailable fallback. */
export function hubPathTarget(path) {
  const parsed = components(path); if (!parsed) return null;
  const { segments: parts, query: q, fragment } = parsed;
  const only = keys => [...q.keys()].every(key => keys.includes(key));
  const bare = !q.size && !fragment;
  const [route, targetId] = parts;
  if (route === 'threads' && parts.length === 2 && id(targetId) && only(['replies', 'page'])) {
    const reply = q.get('replies'), page = q.get('page');
    if (reply !== undefined && !id(reply)) return null;
    if (page !== undefined && !positive(page)) return null;
    const post = fragment ? fragment.match(/^post-([1-9][0-9]*)$/u)?.[1] : undefined;
    if (fragment && !positive(post)) return null;
    return detail('thread', [targetId], 'スレッド', { ...(reply ? { showReplies: true, replyPostId: reply } : {}), ...(post ? { postNo: Number(post) } : {}), ...(page ? { page: Number(page) } : {}) });
  }
  if (route === 'posts' && parts.length === 2 && id(targetId) && !fragment && only(['replies'])) {
    const replies = q.get('replies');
    if (replies !== undefined && !['1', 'recommended', 'latest', 'oldest'].includes(replies)) return null;
    return detail('post', [targetId], '投稿', replies ? { showReplies: true, ...(replies !== '1' ? { replyOrder: replies } : {}) } : {});
  }
  if (route === 'community' && parts.length <= 2 && only(['community', 'channel', 'message', 'section'])) {
    if (parts.length === 2 && q.has('community')) return null;
    const community = targetId ?? q.get('community'), channel = q.get('channel'), message = q.get('message'), section = q.get('section');
    if (community === undefined) return bare ? view('community') : null;
    if (!id(community) || (channel !== undefined && !id(channel)) || (message !== undefined && (!channel || !messageId(message)))) return null;
    if (section !== undefined && (!['members', 'guides', 'governance', 'tokens', 'settings'].includes(section) || channel || message)) return null;
    if (fragment && (!message || fragment !== message)) return null;
    return channel ? detail('channel_messages', [community, channel], 'チャンネル', message ? { messageId: message } : {}) : detail('community', [community], 'コミュニティ', section ? { section } : {});
  }
  if (route === 'research' && parts.length === 2 && project(targetId)) {
    if (fragment === 'git' && only(['gitProposal', 'commit', 'base'])) {
      const proposal = q.get('gitProposal'), commit = q.get('commit'), base = q.get('base');
      if (proposal) return q.size === 1 && uuid(proposal) ? detail('research_git_proposal', [targetId, proposal], 'Git提案のレビュー') : null;
      const oid = value => typeof value === 'string' && [40, 64].includes(value.length) && !/[^a-f0-9]/u.test(value);
      if (base) return q.size === 2 && oid(commit) && oid(base) && commit.length === base.length ? detail('research_git_compare', [targetId, commit, base], 'Gitの二版比較') : null;
      if (commit) return q.size === 1 && oid(commit) ? detail('research_git_commit', [targetId, commit], 'コードの変更') : null;
      return q.size === 0 ? detail('research_git_history', [targetId], 'Gitの変更履歴') : null;
    }
    if (fragment || !only(['document', 'version'])) return null;
    const document = q.get('document'), version = q.get('version');
    if (version) return doc(document) && positive(version) ? detail('research_revision', [targetId, document, version], `文書 · v${version}`) : null;
    return document ? doc(document) ? detail('research_document', [targetId, document], '文書') : null : detail('research_project', [targetId], 'プロジェクト');
  }
  if (route === 'messages' && parts.length === 1 && !fragment && only(['channel', 'conversation'])) {
    const channel = q.get('channel'), conversation = q.get('conversation');
    if (channel) return q.size === 1 && channel === 'email' ? view('mail') : null;
    return conversation ? id(conversation) ? { kind: 'conversation', id: conversation } : null : view('messages');
  }
  if (!bare) return null;
  if (parts.length === 1) return ownValue({ bbs: view('threads'), community: view('community'), research: view('research'), notifications: view('notifications') }, route) ?? null;
  if (parts.length !== 2) return null;
  if (route === 'profile') return doc(targetId) && targetId.length <= 64 ? detail('profile', [targetId], `@${targetId}`) : null;
  if (route === 'tag') return targetId.length <= 128 ? detail('tag', [targetId], `#${targetId}`) : null;
  const ordinary = ownValue({ articles: ['article', '記事'], hubpedia: ['hubpedia_article', 'Hubpedia'], books: ['book', '本'], market: ['listing', '出品'], videos: ['video', '動画'] }, route);
  return ordinary && id(targetId) ? detail(ordinary[0], [targetId], ordinary[1]) : null;
}

/** Notification maps are data, never authority to navigate an arbitrary URL. */
export function notificationTarget(item, profiles = new Map(), threadPostDestinations = {}, communityMessageDestinations = {}) {
  if (!item || typeof item !== 'object') return null;
  const type = ownValue(item, 'targetType'), targetId = ownValue(item, 'targetId');
  if (type === 'system') return hubPathTarget(targetId);
  if (!(type === 'community_message' ? messageId(targetId) : id(targetId))) return null;
  if (type === 'thread_post' || type === 'community_message') {
    const path = ownValue(type === 'thread_post' ? threadPostDestinations : communityMessageDestinations, targetId);
    if (path === undefined) return view(type === 'thread_post' ? 'threads' : 'community');
    const result = hubPathTarget(path);
    return type === 'thread_post'
      ? result?.kind === 'detail' && result.name === 'thread' && result.state?.replyPostId === targetId ? result : null
      : result?.kind === 'detail' && result.name === 'channel_messages' && result.state?.messageId === targetId ? result : null;
  }
  if (type === 'message_conversation') return { kind: 'conversation', id: targetId };
  if (type === 'thread') return detail('thread', [targetId], 'スレッド');
  if (type === 'social_post') return detail('post', [targetId], '投稿');
  if (type === 'profile') {
    const handle = profiles instanceof Map ? ownValue(profiles.get(targetId), 'handle') : undefined;
    return doc(handle) && handle.length <= 64 && handle !== '.' && handle !== '..' ? detail('profile', [handle], `@${handle}`) : view('community');
  }
  return null;
}
