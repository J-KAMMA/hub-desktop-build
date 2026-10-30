// 自分の下書き一覧（Hub Desktop）。
//
// GET /api/client/articles/drafts（読み取り名 article_drafts）の応答を描く。本文は載らない。
// 下書きの編集は Web の Hub の記事エディタ（?draft=ID）で行うので、行を押すと既定のブラウザで開く。
// DOM は textContent / createElement だけで組み、innerHTML は使わない。

const DRAFT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function parseDrafts(value) {
  const list = Array.isArray(value?.drafts) ? value.drafts : [];
  return list
    .filter((d) => d && typeof d.id === 'string' && DRAFT_ID.test(d.id))
    .map((d) => ({
      id: d.id,
      title: typeof d.title === 'string' && d.title.trim() ? d.title : '（題未設定）',
      summary: typeof d.summary === 'string' ? d.summary : '',
      scheduled: d.status === 'scheduled',
      publishAt: typeof d.publishAt === 'string' ? d.publishAt : '',
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
    }));
}

export function draftEditorPath(id) {
  if (typeof id !== 'string' || !DRAFT_ID.test(id)) throw new Error('draft_invalid');
  return `/v2/articles/new?draft=${encodeURIComponent(id)}`;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderDraftList(doc, drafts, { relTime = () => '', onOpen }) {
  const root = el(doc, 'section', 'article-drafts');
  // 「下書き」の見出しは画面の題として既にある。ここでは件数だけを出す。
  if (drafts.length) root.append(el(doc, 'h3', 'result-heading', `${drafts.length}件`));
  if (!drafts.length) {
    root.append(el(doc, 'p', 'meta', '下書きはまだありません。「＋書く」から始められます。'));
    return root;
  }
  for (const draft of drafts) {
    const row = el(doc, 'button', 'card article-draft');
    row.type = 'button';
    row.append(el(doc, 'strong', 'article-draft-title', draft.title));
    if (draft.summary) row.append(el(doc, 'span', 'meta', draft.summary));
    const facts = [draft.scheduled ? '予約公開' : '下書き', draft.updatedAt ? relTime(draft.updatedAt) : ''].filter(Boolean).join(' · ');
    row.append(el(doc, 'span', 'meta', facts));
    row.onclick = () => onOpen(draft);
    root.append(row);
  }
  root.append(el(doc, 'p', 'meta', '下書きはWeb版のHubの記事エディタで開いて続きを書けます。'));
  return root;
}
