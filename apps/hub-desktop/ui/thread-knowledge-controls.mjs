const make = (document, tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const button = (document, text, click) => { const node = make(document, 'button', text, 'head-action'); node.type = 'button'; node.onclick = click; return node; };
const labels = { board: '掲示板', tag: 'タグ', language: '言語', region: '地域' };

export function threadKnowledgeControls(document, { thread, invoke, state = {}, onOpen, confirm = text => document.defaultView.confirm(text) }) {
  const root = make(document, 'details', '', 'card detail-form thread-knowledge'), heading = make(document, 'summary', '共同まとめ・話題フォロー'), content = make(document, 'div', '', 'detail-form');
  const note = make(document, 'p', '', 'meta'); note.setAttribute('role', 'status');
  root.append(heading, content, note); root.open = Boolean(state.open);
  let busy = false, loading = false, loaded = false;
  const lock = value => { busy = value; content.querySelectorAll('button,input,textarea').forEach(node => {
    if (value) { node.dataset.knowledgeDisabled = String(node.disabled); node.disabled = true; }
    else if (node.dataset.knowledgeDisabled !== undefined) { node.disabled = node.dataset.knowledgeDisabled === 'true'; delete node.dataset.knowledgeDisabled; }
  }); };
  const load = async (before = state.before ?? null, onLoaded) => {
    if (loading) return; loading = true; note.textContent = '読み込み中…';
    try {
      const data = await invoke('hub_detail', { name: before === null ? 'thread_knowledge' : 'thread_knowledge_before', ids: before === null ? [thread.id] : [thread.id, String(before)] });
      if (!Array.isArray(data.summaries) || !Array.isArray(data.topics) || !Array.isArray(data.continuation)) throw new Error('共同まとめを確認できませんでした。');
      onLoaded?.(); state.before = before; render(data); loaded = true; note.textContent = '';
    }
    catch (error) { note.textContent = String(error?.message ?? error); if (!loaded) content.replaceChildren(button(document, '再試行', () => load())); }
    finally { loading = false; }
  };
  const act = async (action, extra, validate, success) => {
    if (busy || loading) return; lock(true); note.textContent = '更新中…';
    try {
      const result = await invoke('hub_client_action', { action, target: thread.id, ...extra });
      if (!validate(result)) throw new Error('保存結果を確認できませんでした。入力は保持しています。');
      success?.(result); await load(); note.textContent ||= '更新しました。';
    } catch (error) { note.textContent = String(error?.message ?? error); }
    finally { lock(false); }
  };
  function render(data) {
    if (!Array.isArray(data.summaries) || !Array.isArray(data.topics) || !Array.isArray(data.continuation)) throw new Error('共同まとめを確認できませんでした。');
    const nodes = [], published = data.summaries.find(item => item.status === 'published');
    if (published) { const article = make(document, 'article'); article.append(make(document, 'strong', `公開版 v${published.revision_no}`), make(document, 'p', published.body, 'detail-p')); nodes.push(article); }
    else nodes.push(make(document, 'p', '公開されたまとめはまだありません。', 'meta'));
    if (data.canPropose) {
      const form = make(document, 'form', '', 'detail-form'), text = make(document, 'textarea'); text.rows = 4; text.maxLength = 12000; text.value = state.text ?? ''; text.placeholder = '要点、回答、異なる見方、訂正・出典を整理（20文字以上）'; text.setAttribute('aria-label', 'まとめの提案');
      text.oninput = () => { state.text = text.value; };
      const submit = make(document, 'button', 'まとめを提案', 'head-action'); submit.type = 'submit';
      form.onsubmit = event => {
        event.preventDefault(); const value = text.value.trim();
        if (busy || loading) return;
        if ([...value].length < 20 || value.length > 12000) { note.textContent = 'まとめは20〜12000文字で入力してください。'; return; }
        if (state.request?.text !== value) state.request = { text: value, id: crypto.randomUUID() };
        void act('thread_summary_propose', { text: value, requestId: state.request.id }, result => result.saved === true && result.summaryId === state.request.id, () => { state.text = ''; state.request = null; state.before = null; state.pageCursors = []; text.value = ''; });
      };
      form.append(text, submit, make(document, 'p', '提案は作成者の承認後に公開されます。', 'meta')); nodes.push(form);
    } else nodes.push(make(document, 'p', data.authenticated ? 'このスレッドのまとめは変更できません。' : '提案・フォローにはDesktop接続が必要です。', 'meta'));
    for (const proposal of data.summaries.filter(item => item.status !== 'published')) {
      const article = make(document, 'article'); article.append(make(document, 'small', `${proposal.status === 'proposed' ? '提案' : proposal.status === 'rejected' ? '却下された提案' : '過去版'} v${proposal.revision_no}`), make(document, 'p', proposal.body, 'detail-p'));
      if (data.canManage && proposal.status === 'proposed') article.append(button(document, 'この提案を公開', () => { if (!busy && !loading && confirm('この提案を公開版にしますか？ 現在の公開版を置き換えます。')) void act('thread_summary_publish', { options: { summaryId: proposal.id } }, result => result.published === true && result.summaryId === proposal.id); }));
      nodes.push(article);
    }
    const cursors = state.pageCursors ??= [], page = data.summaryPage;
    if (page?.hasMore || cursors.length) {
      const navigation = make(document, 'nav', '', 'detail-form-row'); navigation.setAttribute('aria-label', '共同まとめの提案ページ');
      const newer = button(document, '新しい20件', () => { if (!busy && !loading && cursors.length) void load(cursors.at(-1), () => cursors.pop()); });
      const older = button(document, '古い20件', () => { if (!busy && !loading && page?.nextBefore) void load(page.nextBefore, () => cursors.push(state.before ?? null)); });
      newer.disabled = !cursors.length; older.disabled = !page?.hasMore; navigation.append(newer, older); nodes.push(navigation);
    }
    if (data.authenticated) {
      const topics = make(document, 'div', '', 'detail-form-row');
      for (const topic of data.topics) topics.append(button(document, `${labels[topic.kind]} ${topic.value} ${topic.following ? 'フォロー解除' : 'フォロー'}`, () => act(topic.following ? 'thread_topic_unsubscribe' : 'thread_topic_subscribe', { options: { kind: topic.kind, value: topic.value } }, result => result.subscribed === !topic.following)));
      nodes.push(topics, button(document, data.archived ? 'あとで読むから外す' : 'あとで読むに保存', () => act(data.archived ? 'thread_unarchive' : 'thread_archive', {}, result => result.archived === !data.archived)));
    }
    for (const item of data.continuation) nodes.push(button(document, item.title || '続きのスレッド', () => onOpen?.(item.id, item.title)));
    if (data.canContinue && data.authenticated) {
      const section = make(document, 'details'), form = make(document, 'form', '', 'detail-form'), title = make(document, 'input'), text = make(document, 'textarea'), anonymous = make(document, 'input'), label = make(document, 'label');
      title.maxLength = 100; title.value = state.nextTitle ?? `${thread.title ?? ''} 続き`.slice(0, 100); title.setAttribute('aria-label', '次スレッドのタイトル');
      text.maxLength = 4000; text.rows = 4; text.value = state.nextText ?? ''; text.placeholder = '次スレッドの背景・引き継ぎ内容（30文字以上）'; text.setAttribute('aria-label', '次スレッドの本文');
      anonymous.type = 'checkbox'; anonymous.checked = Boolean(state.nextAnonymous); label.append(anonymous, document.createTextNode('匿名で投稿'));
      title.oninput = () => { state.nextTitle = title.value; }; text.oninput = () => { state.nextText = text.value; }; anonymous.onchange = () => { state.nextAnonymous = anonymous.checked; };
      const submit = make(document, 'button', '次スレッドを作成', 'head-action'); submit.type = 'submit';
      form.onsubmit = event => {
        event.preventDefault(); if (busy || loading) return;
        const input = { title: title.value.trim(), text: text.value.trim(), identityMode: anonymous.checked ? 'anonymous' : 'account' };
        if (input.title.length < 8 || input.text.length < 30 || input.text.length > 4000) { note.textContent = 'タイトルは8〜100文字、本文は30〜4000文字で入力してください。'; return; }
        const key = JSON.stringify(input); if (state.nextRequest?.key !== key) state.nextRequest = { key, id: crypto.randomUUID() };
        const id = state.nextRequest.id;
        void act('thread_continue', { text: input.text, requestId: id, options: { title: input.title, identityMode: input.identityMode } }, result => result.thread?.id === id, result => { state.nextText = ''; state.nextTitle = ''; state.nextRequest = null; text.value = ''; title.value = ''; onOpen?.(result.thread.id, result.thread.title); });
      };
      form.append(title, text, label, make(document, 'p', '掲示板・言語・地域・投稿範囲を引き継ぎ、前スレッドからリンクします。', 'meta'), submit); section.append(make(document, 'summary', '次スレッドを作る'), form); nodes.push(section);
    }
    content.replaceChildren(...nodes);
  }
  root.ontoggle = () => { state.open = root.open; if (root.open && !loaded) void load(); };
  if (root.open) void load();
  return root;
}
