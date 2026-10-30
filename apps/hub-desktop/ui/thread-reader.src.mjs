import { filterThreadPosts } from '../../hub/lib/thread-search.ts';
import { buildThreadTreeRows } from '../../hub/lib/thread-tree.ts';
import { selectSpotlightPosts } from '../../hub/lib/spotlight-posts.ts';
import { ROLE_LABELS } from '../../hub/lib/thread-knowledge.ts';

// Native controls use the Web reader's search, reply tree and guide selection.
export function createThreadReader(document, { thread, posts, viewer, renderPost, state: reading = {}, selection = null, isCurrent = () => true, onBeforeRender = () => {} }) {
  const root = document.createElement('section');
  root.className = 'thread-reader';
  root.setAttribute('aria-label', '投稿の閲覧');
  const controls = document.createElement('form');
  controls.className = 'detail-form';
  const row = document.createElement('div');
  row.className = 'detail-form-row';
  const input = (label, type = 'text') => {
    const control = document.createElement('input');
    control.type = type; control.setAttribute('aria-label', label); control.placeholder = label;
    return control;
  };
  const select = (label, options) => {
    const control = document.createElement('select'); control.setAttribute('aria-label', label);
    for (const [value, text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; control.append(option); }
    return control;
  };
  const query = input('スレッド内を検索', 'search'); query.maxLength = 100;
  const mode = select('投稿の表示', [['flat','投稿順'],['tree','会話別'],['guide','読み方ガイド']]);
  const sort = select('会話の並び', [['best','おすすめ'],['top','高評価'],['new','新着'],['old','古い順'],['controversial','賛否あり']]);
  row.append(query, mode, sort);
  const advanced = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '詳しく絞り込む';
  const filters = document.createElement('div'); filters.className = 'detail-form-row';
  const author = input('投稿者'); author.maxLength = 80;
  const score = input('最低評価', 'number'); score.step = '1';
  const role = select('投稿の役割', [['all','すべての役割'], ...Object.entries(ROLE_LABELS)]);
  const from = input('投稿日から', 'date'), to = input('投稿日まで', 'date');
  const source = input('出典がある投稿のみ', 'checkbox'), sourceLabel = document.createElement('label'); sourceLabel.className = 'check'; sourceLabel.append(source,'出典あり');
  filters.append(author, score, role, from, to, sourceLabel); advanced.append(summary,filters); controls.append(row,advanced);
  const state = document.createElement('p'); state.className = 'meta'; state.setAttribute('role','status');
  const list = document.createElement('div');
  const pager = document.createElement('div'); pager.className = 'detail-form-row';
  const button = (text, action) => { const item = document.createElement('button'); item.type = 'button'; item.className = 'head-action'; item.textContent = text; item.onclick = action; return item; };
  query.value = reading.query ?? ''; mode.value = reading.mode ?? 'flat'; sort.value = reading.sort ?? 'best';
  author.value = reading.author ?? ''; score.value = reading.score ?? ''; role.value = reading.role ?? 'all';
  from.value = reading.from ?? ''; to.value = reading.to ?? ''; source.checked = reading.source ?? false;
  let page = reading.page ?? 0;
  const selectionStatus = document.createElement('p'); selectionStatus.className = 'meta'; selectionStatus.hidden = true;
  const visible = post => !post.deletedAt && !post.moderatedAt && !post.viewerMuted && !post.viewerBlocked;
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const actualTarget = post => post && typeof post.id === 'string' && post.id.length >= 1 && post.id.length <= 128 && !/[^A-Za-z0-9_-]/u.test(post.id) && positive(post.no) && visible(post);
  const selectionValid = selection && typeof selection === 'object' && !Array.isArray(selection)
    && Object.keys(selection).every(key=>['replyPostId','postNo','page','showReplies'].includes(key))
    && (selection.replyPostId === undefined || typeof selection.replyPostId === 'string' && selection.replyPostId.length >= 1 && selection.replyPostId.length <= 128 && !/[^A-Za-z0-9_-]/u.test(selection.replyPostId))
    && (selection.postNo === undefined || positive(selection.postNo)) && (selection.page === undefined || positive(selection.page))
    && (selection.showReplies === undefined || typeof selection.showReplies === 'boolean');
  const intended = selectionValid && (selection.replyPostId !== undefined || selection.postNo !== undefined || selection.page !== undefined || selection.showReplies === true);
  const key = intended ? JSON.stringify([thread.id,selection.replyPostId??null,selection.postNo??null,selection.page??null,selection.showReplies??false]) : null;
  const firstSelection = key && reading.notificationSelectionKey !== key;
  let targetPost = null, targetId = null, targetNo = null, pendingFocus = false, targetCard = null, observer = null, disposed = false;
  const unavailable = () => { selectionStatus.setAttribute('role','status'); selectionStatus.hidden = false; selectionStatus.textContent = '通知の投稿を表示できません。削除・非表示、または未取得の可能性があります。'; };
  const stopFocus = () => { pendingFocus = false; observer?.disconnect(); observer = null; };
  root.dispose = () => { disposed = true; stopFocus(); };
  if (selection && !selectionValid) unavailable();
  if (firstSelection && isCurrent()) {
    reading.notificationSelectionKey = key;
    if (selection.replyPostId !== undefined || selection.postNo !== undefined) {
      const byId = selection.replyPostId === undefined ? null : posts.filter(post=>post.id === selection.replyPostId);
      const byNo = selection.postNo === undefined ? null : posts.filter(post=>post.no === selection.postNo);
      if ((!byId || byId.length === 1) && (!byNo || byNo.length === 1) && (!byId || !byNo || byId[0] === byNo[0])) targetPost = byId?.[0] ?? byNo?.[0] ?? null;
      if (!actualTarget(targetPost)) { targetPost = null; unavailable(); }
    }
    const requestedPageAvailable = selection.page === undefined || selection.page <= Math.max(1,Math.ceil(posts.length/50));
    if (!targetPost && selection.replyPostId === undefined && selection.postNo === undefined && !requestedPageAvailable) unavailable();
    if (targetPost || selection.replyPostId === undefined && selection.postNo === undefined && requestedPageAvailable) {
      query.value = author.value = score.value = from.value = to.value = ''; role.value = 'all'; source.checked = false; mode.value = 'flat';
      page = targetPost ? Math.floor(posts.indexOf(targetPost)/50) : selection.page ? selection.page-1 : 0;
      targetId = targetPost?.id ?? null; targetNo = targetPost?.no ?? null;
      pendingFocus = Boolean(targetPost);
    }
  }
  const previous = button('前の50件',()=>{stopFocus();selectionStatus.hidden=true;selectionStatus.removeAttribute('role');page--;render();}), next = button('次の50件',()=>{stopFocus();selectionStatus.hidden=true;selectionStatus.removeAttribute('role');page++;render();});
  pager.append(previous,next); root.append(controls,selectionStatus,state,list,pager);
  function render() {
    const searching = Boolean(query.value.trim() || author.value || score.value || role.value !== 'all' || from.value || to.value || source.checked);
    const found = filterThreadPosts(posts, query.value, {author:author.value, minScore:score.value && Number.isFinite(score.valueAsNumber) ? score.valueAsNumber : undefined, role:role.value, from:from.value, to:to.value, hasSource:source.checked});
    const guided = mode.value === 'guide' && !searching;
    const selected = guided ? selectSpotlightPosts(posts,thread.bestAnswerPostId) : found;
    const rows = mode.value === 'tree' && !searching ? buildThreadTreeRows(selected,sort.value) : selected.map(post=>({post,depth:0}));
    const pages = Math.max(1,Math.ceil(rows.length/50)); page = Math.max(0,Math.min(page,pages-1));
    sort.hidden = mode.value !== 'tree' || searching;
    onBeforeRender();
    const nodes = rows.slice(page*50,(page+1)*50).flatMap(({post,depth})=>{
      const card = renderPost(post); card.style.marginInlineStart = `${Math.min(depth,4)*12}px`;
      if (pendingFocus && post === targetPost) { targetCard = card; card.dataset.notificationPostId = post.id; }
      const output = [];
      if(viewer?.lastReadPostNo > 0 && post.no === viewer.lastReadPostNo + 1){const unread = document.createElement('p'); unread.className = 'meta'; unread.textContent = 'ここから未読';output.push(unread);}
      output.push(card);return output;
    });
    list.replaceChildren(...nodes);
    if(!nodes.length){const empty = document.createElement('p');empty.className='meta';empty.textContent='条件に合う投稿はありません';list.append(empty);}
    state.textContent = `${selected.length}件 / ${posts.length}件 · ${page+1} / ${pages}ページ${guided ? ' · 評価は正しさの保証ではありません' : ''}`;
    Object.assign(reading, {query:query.value,mode:mode.value,sort:sort.value,author:author.value,score:score.value,role:role.value,from:from.value,to:to.value,source:source.checked,page});
    previous.disabled = page === 0; next.disabled = page + 1 >= pages; pager.hidden = pages === 1;
  }
  const refresh = ()=>{stopFocus();selectionStatus.hidden=true;selectionStatus.removeAttribute('role');page=0;render();};
  controls.onsubmit = event=>{event.preventDefault();refresh();};
  query.oninput=refresh;
  for(const control of [mode,sort,author,score,role,from,to,source])control.onchange=refresh;
  render();
  const focusTarget = () => {
    if (!pendingFocus) return;
    if (disposed || !isCurrent()) { stopFocus(); return; }
    if (!actualTarget(targetPost) || targetPost.id !== targetId || targetPost.no !== targetNo) { stopFocus(); unavailable(); return; }
    if (!root.isConnected) return;
    if (!targetCard?.isConnected || !root.contains(targetCard)) { stopFocus(); unavailable(); return; }
    stopFocus(); selectionStatus.setAttribute('role','status'); targetCard.tabIndex = -1; targetCard.focus({preventScroll:true}); targetCard.scrollIntoView?.({block:'center',inline:'nearest'});
    selectionStatus.hidden = false; selectionStatus.textContent = `通知の投稿 #${targetPost.no} を表示しました。`;
  };
  if (pendingFocus && document.defaultView?.MutationObserver) {
    observer = new document.defaultView.MutationObserver(focusTarget);
    observer.observe(document.documentElement,{childList:true,subtree:true}); focusTarget();
  }
  return root;
}
