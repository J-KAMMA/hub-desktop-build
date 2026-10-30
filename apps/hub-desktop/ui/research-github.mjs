import {parseGitHubRepositoryInput, contentShareReference} from './content-share-contract.mjs';

const invalid = () => { throw Error('invalid_github_response'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : invalid();
const epochValid = value => Number.isSafeInteger(value) && value >= 0 || value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && typeof value.then !== 'function';
function overview(value, target) {
  const data = object(value);
  try { if (new TextEncoder().encode(JSON.stringify(data)).length > 512 * 1024) invalid(); } catch { invalid(); }
  if (['unavailable', 'rate_limited'].includes(data.status)) {
    if (data.repository !== null || ['issues', 'pullRequests', 'commits'].some(key => data[key] !== null || data.categoryStatuses?.[key] !== data.status)) invalid();
    return {status: data.status};
  }
  if (!['ok', 'partial'].includes(data.status)) invalid();
  const repository = object(data.repository);
  if (repository.name !== target.fullName || repository.href !== target.href || repository.private === true
    || !Number.isSafeInteger(repository.stars) || repository.stars < 0) invalid();
  const result = {status: data.status, repository: {name: target.fullName, href: target.href,
    description: text(repository.description, 1000), defaultBranch: text(repository.defaultBranch, 128), stars: repository.stars}, categoryStatuses: {}};
  if (!result.repository.defaultBranch) invalid();
  for (const key of ['issues', 'pullRequests', 'commits']) {
    const status = data.categoryStatuses?.[key], items = data[key];
    if (!['ok', 'unavailable', 'rate_limited'].includes(status)) invalid();
    result.categoryStatuses[key] = status;
    if (status !== 'ok') { if (items !== null) invalid(); result[key] = null; continue; }
    if (!Array.isArray(items) || items.length > (key === 'commits' ? 5 : 20)) invalid();
    result[key] = items.map(raw => {
      const item = object(raw), title = text(item.title, 300), commit = key === 'commits';
      if (!title || (commit ? typeof item.oid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.oid)
        : !Number.isSafeInteger(item.number) || item.number < 1)) invalid();
      const id = commit ? item.oid : item.number, href = `${target.href}/${commit ? 'commit' : key === 'issues' ? 'issues' : 'pull'}/${id}`;
      if (item.href !== href || contentShareReference(href)?.kind !== 'github') invalid();
      return {title, href, id};
    });
    if (new Set(result[key].map(item => item.id)).size !== items.length) invalid();
  }
  if ((data.status === 'ok') !== Object.values(result.categoryStatuses).every(status => status === 'ok')) invalid();
  return result;
}
let nextId = 0;
export function initNativeGitHub({document, host, readRepository, getContext, isCurrent, onShare, openReference, copyReference}) {
  const node = (tag, value, className = '') => { const element = document.createElement(tag); element.className = className; if (value != null) element.textContent = value; return element; };
  const root = node('section', null, 'card detail-form research-github'); root.hidden = true; root.setAttribute('aria-label', 'GitHubの公開参照');
  const form = node('form', null, 'detail-form'), row = node('div', null, 'detail-form-row research-github__field');
  const input = node('input'); input.type = 'text'; input.id = `native-github-repository-${++nextId}`; input.maxLength = 180; input.autocapitalize = 'none'; input.spellcheck = false;
  const label = node('label', 'GitHubリポジトリ'); label.htmlFor = input.id;
  const hint = node('p', '例: microsoft/vscode。入力した名前をGitHubへ送ります。公開情報だけを読み、編集・認証はGitHubの原本で行います。', 'meta');
  hint.id = `${input.id}-hint`; input.setAttribute('aria-describedby', hint.id);
  const submit = node('button', '公開情報を確認', 'head-action'); submit.type = 'submit';
  const original = node('button', 'GitHubで開く', 'head-action'); original.type = 'button'; original.disabled = true;
  const closeButton = node('button', '閉じる', 'head-action'); closeButton.type = 'button';
  const state = node('p', '', 'meta'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
  const output = node('div', null, 'detail-form'), actions = node('div', null, 'research-github__actions'), header = node('div', null, 'research-github__header');
  row.append(label, input); actions.append(submit, original); form.append(row, hint, actions); header.append(node('h3', 'GitHub'), closeButton);
  root.append(header, form, state, output); host.append(root);
  let serial = 0, accepted = -1, disposed = false, busy = false, viewScope = null;
  const listeners = [];
  function listen(element, event, run) { element.addEventListener(event, run); listeners.push([element, event, run]); }
  async function context() {
    try {
      const value = await getContext(), url = new URL(value.origin);
      if (url.origin !== value.origin || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        || typeof value.key !== 'string' || !epochValid(value.epoch)) return null;
      return {origin: value.origin, key: value.key, epoch: value.epoch};
    } catch { return null; }
  }
  const live = () => !disposed && !root.hidden && root.isConnected && host.contains(root);
  const sameScope = (scope, now) => scope && now && ['origin', 'key', 'epoch'].every(key => now[key] === scope[key]);
  function current(scope, ticket, draft) {
    try { return !!scope && live() && serial === ticket && input.value === draft && (typeof isCurrent !== 'function' || isCurrent(scope) === true); } catch { return false; }
  }
  async function fresh(scope, ticket, draft) {
    const now = await context();
    if (current(scope, ticket, draft) && sameScope(scope, now)) return true;
    if (serial === ticket && !disposed) invalidate('接続または表示が変わりました。取得し直してください。');
    return false;
  }
  async function openHref(href, scope, ticket, draft, event, sourceCurrent) {
    const valid = () => current(scope, ticket, draft) && sourceCurrent() === true;
    if (typeof openReference !== 'function' || !await fresh(scope, ticket, draft) || !valid()) return;
    try { await openReference(href, event, valid); await fresh(scope, ticket, draft); }
    catch { if (await fresh(scope, ticket, draft)) state.textContent = '原本を開けませんでした。'; }
  }
  function pending(value) { busy = value; submit.disabled = value || typeof readRepository !== 'function'; submit.textContent = value ? '取得中…' : '公開情報を確認'; root.setAttribute('aria-busy', String(value)); }
  function invalidate(message = '') {
    serial++; accepted = -1; viewScope = null;
    output.querySelectorAll('a').forEach(link => link.removeAttribute('href'));
    output.querySelectorAll('button').forEach(button => { button.disabled = true; });
    output.replaceChildren(); state.textContent = message; pending(false);
    original.disabled = !parseGitHubRepositoryInput(input.value) || typeof openReference !== 'function';
  }
  function links(parent, href, title, scope, ticket, draft) {
    const valid = () => {
      if (accepted !== ticket || !parent.isConnected || !output.contains(parent)) return false;
      if (current(scope, ticket, draft)) return true;
      if (serial === ticket) invalidate('接続または表示が変わりました。取得し直してください。');
      return false;
    };
    parent.classList.add('research-github__row');
    const link = node('a', title, 'research-github__link'); link.href = href;
    link.onclick = link.onauxclick = async event => {
      if (event.type === 'click' ? event.button !== 0 : event.button !== 1) return;
      event.preventDefault(); if (!valid() || typeof openReference !== 'function') return;
      await openHref(href, scope, ticket, draft, event, () => valid() && link.isConnected && parent.contains(link) && link.getAttribute('href') === href);
    };
    const share = node('button', '投稿で紹介', 'head-action'); share.type = 'button'; share.disabled = typeof onShare !== 'function';
    let sharing = false;
    share.onclick = async () => {
      if (sharing || !valid() || typeof onShare !== 'function' || contentShareReference(href)?.kind !== 'github') return;
      sharing = true; share.disabled = true; share.setAttribute('aria-busy', 'true'); state.textContent = '紹介先を確認しています…';
      try {
        if (!await fresh(scope, ticket, draft) || !valid()) return;
        const offered = await onShare({href, title, isCurrent: valid});
        if (await fresh(scope, ticket, draft) && valid()) state.textContent = offered ? '' : '紹介先を開けませんでした。';
      }
      catch { if (await fresh(scope, ticket, draft) && valid()) state.textContent = '紹介先を開けませんでした。'; }
      finally { sharing = false; if (valid()) { share.disabled = false; share.setAttribute('aria-busy', 'false'); } }
    };
    const actions = node('span', null, 'research-github__actions'); actions.append(share);
    if (typeof copyReference === 'function') {
      const copy = node('button', 'URLをコピー', 'head-action'); copy.type = 'button'; let copying = false;
      copy.onclick = async () => {
        if (copying || !valid() || contentShareReference(href)?.kind !== 'github') return;
        copying = true; copy.disabled = true; copy.setAttribute('aria-busy', 'true');
        try {
          if (!await fresh(scope, ticket, draft) || !valid()) return;
          const copied = await copyReference(href);
          if (await fresh(scope, ticket, draft) && valid()) state.textContent = copied === false ? 'URLをコピーできませんでした。' : 'URLをコピーしました。';
        } catch { if (await fresh(scope, ticket, draft) && valid()) state.textContent = 'URLをコピーできませんでした。'; }
        finally { copying = false; if (valid()) { copy.disabled = false; copy.setAttribute('aria-busy', 'false'); } }
      };
      actions.append(copy);
    }
    parent.append(link, actions);
  }
  function render(data, scope, ticket, draft) {
    const repository = data.repository, heading = node('h4'); output.append(heading);
    links(heading, repository.href, repository.name, scope, ticket, draft);
    output.append(node('p', repository.description), node('p', `既定ブランチ: ${repository.defaultBranch} · ${repository.stars} stars`, 'meta'),
      node('p', '課題・変更提案は更新順の最新20件、コミットは最新5件の公開参照です。', 'meta'));
    for (const [key, title] of [['issues', '課題（Issues）'], ['pullRequests', '変更提案（Pull requests）'], ['commits', '変更履歴']]) {
      const section = node('section', null, 'detail-form'); section.setAttribute('aria-label', title); section.append(node('h4', title)); output.append(section);
      if (data.categoryStatuses[key] !== 'ok') { section.append(node('p', data.categoryStatuses[key] === 'rate_limited' ? '取得制限のためこの一覧を確認できません。' : 'この一覧を取得できませんでした。', 'meta')); continue; }
      if (!data[key].length) { section.append(node('p', key === 'commits' ? '履歴はありません。' : '取得した最新20件に該当する項目はありません。', 'meta')); continue; }
      const list = node('ul', null, 'research-github__list'); section.append(list);
      for (const item of data[key]) { const entry = node('li'); list.append(entry); links(entry, item.href, `${key === 'commits' ? item.id.slice(0, 7) : '#' + item.id} ${item.title}`, scope, ticket, draft); }
    }
  }
  async function read() {
    if (!live() || busy || typeof readRepository !== 'function') return false;
    invalidate(); const draft = input.value, target = parseGitHubRepositoryInput(draft), ticket = serial; let scope = null;
    if (!target) { state.textContent = 'owner/repository またはGitHubのリポジトリURLを入力してください。'; input.focus(); return false; }
    pending(true); state.textContent = '公開情報を確認しています…';
    try {
      scope = await context();
      if (!current(scope, ticket, draft)) { if (serial === ticket) invalidate('接続を確認できません。取得し直してください。'); return false; }
      viewScope = scope;
      const raw = await readRepository(target.fullName);
      if (!await fresh(scope, ticket, draft)) return false;
      const data = overview(raw, target);
      if (!current(scope, ticket, draft)) { if (serial === ticket) invalidate('接続または表示が変わりました。取得し直してください。'); return false; }
      if (data.status === 'rate_limited') { state.textContent = 'GitHubの取得制限に達しました。時間をおいて再試行してください。'; return false; }
      if (data.status === 'unavailable') { state.textContent = '公開情報を取得できませんでした。非公開リポジトリの閲覧はGitHubで行ってください。'; return false; }
      accepted = ticket; state.textContent = data.status === 'partial' ? '一部の一覧を取得できませんでした。確認できた公開参照だけを表示します。' : '公開情報を取得しました。';
      render(data, scope, ticket, draft); return true;
    } catch (error) {
      if (await fresh(scope, ticket, draft)) state.textContent = error?.message === 'invalid_github_response' ? 'リポジトリの応答が表示対象と一致しないか、表示上限を超えています。' : '公開情報を取得できませんでした。';
      return false;
    } finally { if (serial === ticket && !disposed) pending(false); }
  }
  listen(form, 'submit', event => { event.preventDefault(); void read(); });
  listen(input, 'input', () => invalidate());
  listen(original, 'click', async event => {
    const target = parseGitHubRepositoryInput(input.value), draft = input.value, ticket = serial, previous = viewScope;
    if (!target || !live() || typeof openReference !== 'function') return;
    const scope = await context();
    if (previous && !sameScope(previous, scope)) { if (serial === ticket) invalidate('接続または表示が変わりました。取得し直してください。'); return; }
    if (current(scope, ticket, draft)) await openHref(target.href, scope, ticket, draft, event, () => original.isConnected && root.contains(original));
  });
  const close = () => { invalidate(); root.hidden = true; };
  listen(closeButton, 'click', close);
  for (const event of ['hub-account-changed', 'hub-origin-changed']) if (document.defaultView) listen(document.defaultView, event, () => invalidate('接続またはプロフィールが変わりました。取得し直してください。'));
  pending(false);
  return {root, read, close, invalidate,
    async open() {
      if (disposed) return false;
      invalidate(); const ticket = serial, draft = input.value; root.hidden = false; input.focus();
      const scope = await context();
      if (!current(scope, ticket, draft)) { if (serial === ticket) invalidate('接続を確認できません。取得し直してください。'); return false; }
      viewScope = scope; return true;
    },
    dispose() { if (disposed) return; invalidate(); disposed = true; listeners.forEach(([element, event, run]) => element.removeEventListener(event, run)); root.remove(); },
  };
}
