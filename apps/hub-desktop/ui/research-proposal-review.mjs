import {researchProposalDiscussions} from './research-proposal-discussions.mjs';
const node = (d, tag, text, cls = '') => { const n = d.createElement(tag); if (text != null) n.textContent = text; n.className = cls; return n; };
const id = value => typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
const uuid = value => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const version = value => Number.isSafeInteger(value) && value > 0;
const text = (value, max) => typeof value === 'string' && value.length <= max;
const denied = error => /見つかりませんでした|このアカウントは停止|権限がありません|ハブが (?:401|403|404) を返しています|desktop_not_connected|research_(?:accept|reject)_rejected:(?:401|403|404):/.test(String(error?.message ?? error));
const statusLabels = {open: '確認待ち', accepted: '採用済み', rejected: '見送り済み'};
const decisionLabels = {accept: '採用', reject: '見送り'};
const revisionHref = (p, doc, v) => `/v2/research/${encodeURIComponent(p)}?document=${encodeURIComponent(doc)}&version=${v}`;
const invalid = () => { throw Error('変更提案の比較内容を確認できませんでした。'); };
function adopted(value, p, doc, base, contentHash) {
  if (!value || !version(value.version) || value.version !== base + 1 || !hash(value.contentHash) || value.contentHash !== contentHash || value.href !== revisionHref(p, doc, value.version)) invalid();
  return {version: value.version, contentHash: value.contentHash, href: value.href};
}
function preparation(value, reference) {
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 2 * 1024 * 1024) invalid(); } catch { invalid(); }
  const p = value?.proposal, doc = value?.document, base = value?.baseRevision, snapshot = value?.snapshot;
  if (!p || !doc || !base || !snapshot || p.id !== reference.proposalId || !uuid(p.id) || !id(doc.id) || p.documentId !== doc.id || doc.projectId !== reference.projectId || !id(doc.projectId)
    || !text(doc.title, 240) || !doc.title.trim() || /[\u0000-\u001f\u007f]/u.test(doc.title) || !['public', 'confidential'].includes(doc.visibility) || !version(doc.head)
    || !version(p.baseVersion) || !text(p.body, 100000) || !text(p.summary, 500) || !Object.hasOwn(statusLabels, p.status) || !hash(p.contentHash) || !text(p.createdAt, 40) || !Number.isFinite(Date.parse(p.createdAt))
    || base.version !== p.baseVersion || !text(base.body, 100000) || !hash(base.contentHash)
    || snapshot.proposalId !== p.id || snapshot.baseVersion !== p.baseVersion || !hash(snapshot.proposalHash) || snapshot.baseHash !== base.contentHash || snapshot.currentHead !== doc.head
    || typeof value.canDecide !== 'boolean' || typeof value.canDiscuss !== 'boolean' || (value.canDiscuss && doc.visibility !== 'public')) invalid();
  const result = p.status === 'accepted' ? adopted(value.adoptedRevision, reference.projectId, doc.id, p.baseVersion, p.contentHash) : value.adoptedRevision === null ? null : invalid();
  return {proposal: {id: p.id, documentId: p.documentId, baseVersion: p.baseVersion, body: p.body, summary: p.summary, status: p.status, createdAt: p.createdAt, contentHash: p.contentHash},
    document: {id: doc.id, projectId: doc.projectId, title: doc.title, visibility: doc.visibility, head: doc.head}, baseRevision: {version: base.version, body: base.body, contentHash: base.contentHash},
    snapshot: {proposalId: p.id, baseVersion: p.baseVersion, proposalHash: snapshot.proposalHash, baseHash: snapshot.baseHash, currentHead: snapshot.currentHead}, canDecide: value.canDecide, canDiscuss: value.canDiscuss, adoptedRevision: result};
}
function result(value, reference, review) {
  const expected = review.action === 'accept' ? 'accepted' : 'rejected';
  if (value?.proposalId !== reference.proposalId || value.status !== expected) throw Error('判断結果を確認できません。同じ内容で再試行してください。');
  return {proposalId: value.proposalId, status: expected, adoptedRevision: expected === 'accepted' ? adopted(value.adoptedRevision, reference.projectId, review.documentId, review.options.snapshot.baseVersion, review.contentHash) : value.adoptedRevision === null ? null : invalid()};
}

export function researchProposalReview(target, reference, options = {}) {
  reference = {projectId: reference?.projectId, proposalId: reference?.proposalId};
  const d = target.ownerDocument, root = node(d, 'section', null, 'research-proposal-review research-project-detail'), storage = options.state ?? {}, entries = storage.proposalReviews ??= {}, key = JSON.stringify([reference.projectId, reference.proposalId]), state = entries[key] ??= {};
  target.append(root); let active = true, initialPrepared = options.prepared, discussions; options = {...options, prepared: undefined};
  const discussionHost = node(d, 'div');
  const valid = () => !state.invalidated && entries[key] === state;
  const live = () => active && valid();
  const sync = () => state.sync?.();
  const fail = error => { const message = String(error?.message ?? error).replace(/^research_(?:accept|reject)_rejected:(?:400|401|403|404|409):/, ''); return options.friendlyError?.(message) ?? message; };
  function button(label, run) { const n = node(d, 'button', label, 'head-action'); n.type = 'button'; n.onclick = () => { if (live()) return run(); }; return n; }
  function clearReader() { initialPrepared = undefined; delete state.prepared; delete state.reviewFingerprint; state.needsPreparation = true; discussions?.clearReader(); discussions?.dispose(); discussions = undefined; discussionHost.replaceChildren(); }
  function render() {
    if (!live()) return;
    root.replaceChildren(node(d, 'h3', '変更提案を比較して確認'));
    const notice = node(d, 'p', state.error ?? '', state.error ? 'meta warning' : 'meta'); notice.setAttribute('role', 'status'); root.append(notice);
    if (state.saved) {
      root.append(node(d, 'p', `${decisionLabels[state.saved.status === 'accepted' ? 'accept' : 'reject']}は保存済みです。`, 'meta'));
      const revision = state.saved.adoptedRevision;
      if (revision && options.openRevision) root.append(button(`採用したv${revision.version}を開く`, () => options.openRevision(reference.projectId, state.savedDocumentId, revision.version, '採用した版')));
    }
    if (state.needsConnection && options.connectAccount) root.append(button('Desktopを接続', options.connectAccount));
    if (state.loading) root.append(node(d, 'p', '基準版と変更提案を確認しています…', 'meta'));
    const data = state.prepared;
    if (data) {
      const {proposal: p, document: doc, baseRevision: base} = data;
      root.append(node(d, 'h4', doc.title), node(d, 'p', `基準 v${p.baseVersion} · 現在の最新版 v${doc.head} · ${doc.visibility === 'public' ? '公開文書' : '非公開文書'} · ${statusLabels[state.saved?.status ?? p.status]}`, 'meta'), node(d, 'h4', '変更の理由'), node(d, 'p', p.summary), node(d, 'p', p.createdAt, 'meta'));
      const comparison = node(d, 'div', null, 'research-proposal-comparison');
      for (const [title, body, contentHash] of [[`基準版 v${base.version}`, base.body, base.contentHash], ['提案された本文', p.body, p.contentHash]]) {
        const section = node(d, 'section'); section.append(node(d, 'h4', title), node(d, 'code', contentHash), node(d, 'pre', body, 'research-document-body')); comparison.append(section);
      }
      root.append(comparison, node(d, 'p', '未採用の本文と変更の理由は、提案者と所有者だけが確認できます。議論では採用済みの基準版を参照します。', 'meta'));
      if (options.openRevision) root.append(button(`基準のv${base.version}を開く`, () => options.openRevision(reference.projectId, doc.id, base.version, doc.title)));
      if (data.canDiscuss && options.openDiscussion) root.append(button(`基準のv${base.version}について議論する`, () => options.openDiscussion(reference.projectId, doc.id, base.version, '基準版について議論')));
      else root.append(node(d, 'p', '公開された基準版を確認できる場合に、スレッドで議論できます。', 'meta'));
      if (!state.saved && p.status !== 'open') {
        root.append(node(d, 'p', 'この提案の採否は確定しています。もう一度判断することはできません。', 'meta'));
        if (data.adoptedRevision && options.openRevision) root.append(button(`採用したv${data.adoptedRevision.version}を開く`, () => options.openRevision(reference.projectId, doc.id, data.adoptedRevision.version, doc.title)));
      }
    }
    if (!state.saved && state.review && (state.locked || (data?.canDecide && data.proposal.status === 'open'))) {
      const action = state.review.action, preview = node(d, 'section', null, 'research-proposal-preview');
      preview.dataset.researchProposalPreview = '';
      preview.append(node(d, 'h4', `${decisionLabels[action]}の確認`));
      if (!state.locked && data) preview.append(node(d, 'p', `${data.document.title} · 基準 v${state.review.options.snapshot.baseVersion} · 最新版 v${state.review.options.snapshot.currentHead}`), node(d, 'p', data.proposal.summary));
      preview.append(node(d, 'p', state.locked ? '前回確認した判断の結果を確認します。判断対象は変更しません。' : action === 'accept' ? '提案された本文を' + (data.document.visibility === 'public' ? '公開' : '非公開') + 'の新しい版として採用します。' : 'この提案を見送ります。採用済みの本文と最新版は変更しません。'));
      if (state.uncertain) preview.append(node(d, 'p', '判断結果が不明です。判断と参照を変えずに同じ操作の結果を確認してください。', 'meta'));
      const execute = button(state.locked ? '同じ判断の結果を確認する' : `${decisionLabels[action]}を確定`, () => decide()); execute.dataset.researchProposalExecute = ''; execute.disabled = Boolean(state.sending || state.loading); preview.append(execute);
      if (!state.locked) preview.append(button('比較に戻る', () => { delete state.review; delete state.reviewFingerprint; sync(); })); root.append(preview);
    } else if (!state.saved && data?.proposal.status === 'open' && !state.locked) {
      if (!data.canDecide) root.append(node(d, 'p', '採否の判断にはプロジェクト所有者の権限が必要です。', 'meta'));
      else {
        const accept = button('採用を確認', () => preview('accept')), reject = button('見送りを確認', () => preview('reject'));
        accept.disabled = Boolean(state.sending || state.loading || data.document.head !== data.proposal.baseVersion || !version(data.proposal.baseVersion + 1)); reject.disabled = Boolean(state.sending || state.loading); root.append(accept, reject);
        if (data.document.head !== data.proposal.baseVersion) root.append(node(d, 'p', '基準版から最新版が変わっているため採用できません。最新版を確認してください。見送りは可能です。', 'meta'));
        else if (!version(data.proposal.baseVersion + 1)) root.append(node(d, 'p', '版番号の表示上限に達しているため採用できません。見送りは可能です。', 'meta'));
      }
    }
    const read = button('比較内容を再確認', () => load(true)); read.disabled = Boolean(state.loading || state.sending); root.append(read);
    if (data) { root.append(discussionHost); discussions ??= researchProposalDiscussions(discussionHost, reference, options); }
  }
  function preview(action) {
    const data = state.prepared;
    if (!live() || state.saved || state.locked || state.loading || state.sending || !data?.canDecide || data.proposal.status !== 'open' || (action === 'accept' && (data.document.head !== data.proposal.baseVersion || !version(data.proposal.baseVersion + 1)))) return;
    state.review = {action, options: Object.freeze({proposalId: reference.proposalId, snapshot: Object.freeze({...data.snapshot})}), documentId: data.document.id, contentHash: data.proposal.contentHash}; state.reviewFingerprint = JSON.stringify([data.snapshot, data.document, data.proposal.summary, data.canDecide, data.canDiscuss]); state.error = ''; sync();
  }
  async function decide() {
    if (!live() || state.saved || state.sending || state.loading || !state.review) return;
    const review = state.review, wasUncertain = state.uncertain;
    state.locked = true; state.sending = true; state.error = ''; sync();
    try {
      const response = await options.invoke('hub_client_action', {action: `research_${review.action}`, target: reference.projectId, options: review.options});
      if (!valid()) return;
      state.saved = result(response, reference, review); state.savedDocumentId = review.documentId; state.uncertain = false; delete state.review; delete state.reviewFingerprint; sync();
      if (live()) await load(true);
    } catch (error) {
      if (valid()) {
        const confirmed = new RegExp(`^research_${review.action}_rejected:(?:400|403|404|409):`).test(String(error?.message ?? error));
        state.error = fail(error); state.uncertain = Boolean(wasUncertain || !confirmed); state.locked = state.uncertain;
        if (denied(error) || confirmed) clearReader();
        if (!state.uncertain) delete state.review;
        state.needsConnection = /desktop_not_connected|ハブが 401 を返しています/.test(String(error?.message ?? error));
      }
    } finally { if (valid()) { state.sending = false; sync(); } }
  }
  async function load(force = false) {
    if (!live() || (state.sending && !state.saved)) return;
    const token = {}; state.readToken = token; state.loading = true; state.error = ''; sync();
    try {
      if (!id(reference.projectId) || !uuid(reference.proposalId)) invalid();
      const response = (!force && !state.needsPreparation && initialPrepared !== undefined) ? initialPrepared : await options.invoke('hub_detail', {name: 'research_proposal', ids: [reference.projectId, reference.proposalId]});
      initialPrepared = undefined;
      if (!valid() || state.readToken !== token) return;
      const data = preparation(response, reference);
      if (state.saved && data.proposal.status !== state.saved.status) throw Error('保存結果と最新の比較内容が一致しません。再確認してください。');
      state.prepared = data; state.needsPreparation = false; state.needsConnection = false;
      if (state.review && !state.locked && state.reviewFingerprint !== JSON.stringify([data.snapshot, data.document, data.proposal.summary, data.canDecide, data.canDiscuss])) { delete state.review; delete state.reviewFingerprint; }
    } catch (error) {
      if (valid() && state.readToken === token) { clearReader(); if (!state.locked) delete state.review; state.error = `${state.saved ? '判断は保存済みです。最新の比較内容を確認できませんでした: ' : ''}${fail(error)}`; state.needsConnection = /desktop_not_connected|ハブが 401 を返しています/.test(String(error?.message ?? error)); }
    } finally { if (valid() && state.readToken === token) { state.loading = false; delete state.readToken; sync(); } }
  }
  function invalidate() {
    initialPrepared = undefined;
    discussions?.invalidate(); discussions?.dispose(); discussions = undefined; discussionHost.replaceChildren();
    for (const entry of Object.values(entries)) { const notify = entry.sync; for (const name of Object.keys(entry)) delete entry[name]; entry.invalidated = true; notify?.(); }
    for (const name of Object.keys(entries)) delete entries[name];
    root.replaceChildren(node(d, 'p', '接続が変わりました。提案を読み直してください。', 'meta'));
  }
  function dispose() { if (!active) return; active = false; discussions?.dispose(); d.defaultView?.removeEventListener('hub-account-changed', invalidate); if (state.sync === render) delete state.sync; for (const control of root.querySelectorAll('button')) control.disabled = true; }
  d.defaultView?.addEventListener('hub-account-changed', invalidate); state.sync = render; render(); const ready = load().then(() => discussions?.ready);
  return {root, ready, dispose, invalidate};
}





