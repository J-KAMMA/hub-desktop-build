import { contentShareReference, appendContentShare } from './content-share-contract.mjs';

const publicReference = href => {
  const value = contentShareReference(href);
  return value;
};
function context(value) {
  if (!value || typeof value.origin !== 'string' || value.origin.length > 512 ||
      typeof value.key !== 'string' || !value.key || value.key.length > 2048 || !value.epoch) return null;
  try {
    const url = new URL(value.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.origin || url.username || url.password) return null;
    return { origin: value.origin, key: value.key, epoch: value.epoch };
  } catch { return null; }
}
const sameContext = (a, b) => Boolean(a && b && a.origin === b.origin && a.key === b.key && a.epoch === b.epoch);

/** Public metadata only. The existing composer owns drafts, attachments and submission. */
export function createContentShare({ document, host, textarea, getContext, isCurrent, onNavigate, onChanged, onOpenReference }) {
  const element = document.createElement('section');
  element.className = 'card content-share-preview'; element.hidden = true; element.setAttribute('aria-label', '投稿で紹介');
  const heading = document.createElement('strong'), link = document.createElement('p'), state = document.createElement('p');
  link.className = state.className = 'meta'; state.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'detail-form-row';
  const add = document.createElement('button'), open = document.createElement('button'), dismiss = document.createElement('button');
  for (const button of [add, open, dismiss]) { button.type = 'button'; button.className = 'head-action'; }
  add.textContent = '紹介リンクを追加'; open.textContent = '元の対象を開く'; open.hidden = typeof onOpenReference !== 'function';
  dismiss.textContent = '閉じる'; actions.append(add, open, dismiss);
  element.append(heading, link, state, actions); host.append(element);
  let revision = 0, disposed = false, busy = false, preview = null;
  const attached = () => !disposed && element.isConnected && host.contains(element) && textarea.isConnected;
  const current = token => attached() && token === revision && isCurrent() === true;
  function invalidate() {
    revision++; preview = null; busy = false; element.hidden = true;
    heading.textContent = link.textContent = state.textContent = ''; add.disabled = open.disabled = false;
  }
  dismiss.onclick = invalidate;
  open.onclick = async event => {
    if (busy || !preview || !current(revision) || typeof onOpenReference !== 'function') return false;
    const token = revision, selected = preview; busy = true; add.disabled = open.disabled = true;
    try {
      const fresh = context(await getContext());
      if (!current(token)) return false;
      if (!sameContext(selected.context, fresh)) { invalidate(); return false; }
      const valid = () => current(token) && preview === selected;
      return await onOpenReference(new URL(selected.reference.href, fresh.origin).href, valid, event) !== false;
    } catch {
      if (current(token)) state.textContent = '元の対象を開けませんでした。草稿は保持しています。';
      return false;
    } finally { if (token === revision) { busy = false; add.disabled = open.disabled = false; } }
  };
  add.onclick = async () => {
    if (busy || !preview || !current(revision)) return false;
    const token = revision, selected = preview; busy = true; add.disabled = true;
    try {
      const fresh = context(await getContext());
      if (!current(token)) return false;
      if (!sameContext(selected.context, fresh)) { invalidate(); return false; }
      // Read the live draft only after the scope check; never restore an earlier draft.
      const body = textarea.value, next = appendContentShare(body, selected.reference.href, fresh.origin);
      if (next !== body) {
        textarea.value = next;
        textarea.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
        onChanged?.();
      }
      state.textContent = '紹介リンクを追加しました。内容を確認して「ポスト」で送信できます。';
      return true;
    } catch (error) {
      if (current(token)) state.textContent = error?.message === 'content_share_full'
        ? '本文と紹介リンクが500文字を超えます。草稿は保持しています。'
        : '紹介リンクを追加できませんでした。草稿は保持しています。';
      return false;
    } finally { if (token === revision) { busy = false; add.disabled = false; } }
  };
  async function offer({ href, title, isCurrent: sourceCurrent }) {
    if (!attached() || !sourceCurrent?.()) return false;
    invalidate(); const token = revision, reference = publicReference(href);
    if (!reference || typeof title !== 'string' || title.length > 1000) return false;
    try {
      const captured = context(await getContext());
      if (!attached() || token !== revision || !sourceCurrent() || !captured) return false;
      await onNavigate();
      if (!current(token)) return false;
      const fresh = context(await getContext());
      if (!current(token) || !sameContext(captured, fresh)) return false;
      preview = { reference, context: fresh }; heading.textContent = title || ({article:'記事を紹介',video:'動画を紹介',music:'音楽を紹介',product:'商品を紹介',post:'投稿を紹介',project:'プロジェクトを紹介',git:'コードの変更を紹介',github:'GitHubの参照を紹介',research:'研究の公開版を紹介'}[reference.kind]);
      link.textContent = new URL(reference.href, fresh.origin).href; state.textContent = '公開ページのリンクを草稿に追加します。紹介文は本文欄で編集できます。';
      element.hidden = false; textarea.focus(); return true;
    } catch { return false; }
  }
  return { element, offer, invalidate, destroy() { invalidate(); disposed = true; element.remove(); } };
}

export function attachContentShare({ document, host, kind, id, title, isCurrent, onShare }) {
  const href = `/v2/${kind === 'article' ? 'articles' : 'videos'}/${id}`;
  if (!['article', 'video'].includes(kind) || !publicReference(href)) return null;
  const element = document.createElement('button'); element.type = 'button'; element.className = 'head-action'; element.textContent = '投稿で紹介';
  let disposed = false, busy = false;
  const current = () => !disposed && element.isConnected && host.contains(element) && isCurrent();
  element.onclick = async () => {
    if (busy || !current()) return false;
    busy = true; element.disabled = true;
    try { return await onShare({ href, title, isCurrent: current }); }
    finally { busy = false; if (!disposed) element.disabled = false; }
  };
  host.append(element);
  return { element, destroy() { disposed = true; element.remove(); } };
}
