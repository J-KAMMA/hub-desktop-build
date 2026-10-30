import {contentShareReference} from './content-share-contract.mjs';
const invalid = () => { throw new Error('invalid_git_response'); };
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
const oidValid = value => typeof value === 'string' && (value.length === 40 || value.length === 64) && /^[a-f0-9]+$/.test(value);
const text = (value, max, controls = false) => typeof value === 'string' && value.length <= max && (controls || !/[\u0000-\u001f\u007f]/u.test(value)) ? value : invalid();
function bounded(value) {
  try { const json = JSON.stringify(value); if (json === undefined || new TextEncoder().encode(json).length > 512 * 1024) invalid(); } catch { invalid(); }
}
function metadata(value) {
  const row = record(value);
  if (!oidValid(row.oid) || !Array.isArray(row.parentOids) || row.parentOids.length > 100 || !row.parentOids.every(parent => oidValid(parent) && parent.length === row.oid.length)) invalid();
  const committedAt = text(row.committedAt, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(committedAt) || !Number.isFinite(Date.parse(committedAt))) invalid();
  return {oid: row.oid, parentOids: [...row.parentOids], subject: text(row.subject, 4096), committedAt};
}
function history(value, projectId) {
  bounded(value); const row = record(value);
  if (row.projectId !== projectId || !Array.isArray(row.commits) || row.commits.length > 20) invalid();
  const commits = row.commits.map(metadata);
  if (new Set(commits.map(commit => commit.oid)).size !== commits.length) invalid();
  return {projectId, commits};
}
export function parseNativeGitDetail(value, projectId, oid, baseOid) {
  bounded(value); const row = record(value), commit = metadata(row.commit);
  if (row.projectId !== projectId || commit.oid !== oid || row.baseOid!==baseOid || baseOid!==undefined&&(!oidValid(baseOid)||baseOid.length!==oid.length) || !Array.isArray(row.files) || row.files.length > 100 || typeof row.truncated !== 'boolean') invalid();
  const message = text(record(row.commit).message, 65536, true);
  if (new TextEncoder().encode(message).length > 65536) invalid();
  const pathText = value => { const path = text(value, 8192, true); return path && !path.includes('\0') ? path : invalid(); };
  const files = row.files.map(value => {
    const file = record(value), path = pathText(file.path), status = text(file.status, 4);
    if (!/^(?:[AMDT]|[RC](?:100|[1-9]?[0-9]))$/.test(status)) invalid();
    return {path, status, ...(file.oldPath === undefined ? {} : {oldPath: pathText(file.oldPath)})};
  });
  return {projectId, commit: {...commit, message}, files, diff: text(row.diff, 100000, true), truncated: row.truncated,...(baseOid===undefined?{}:{baseOid})};
}
const detail=parseNativeGitDetail;
const node = (document, tag, value, className = '') => { const result = document.createElement(tag); result.className = className; if (value != null) result.textContent = value; return result; };
const clipped = value => { const points = Array.from(value); return points.length > 80 ? points.slice(0, 80).join('') + '…' : value; };
const href = (projectId, oid, base) => `/v2/research/${encodeURIComponent(projectId)}?commit=${oid}${base?`&base=${base}`:''}#git`;
const readDenied = error => /見つかりませんでした|このアカウントは停止されているか、権限がありません|ハブが 401 を返しています|desktop_not_connected/.test(String(error?.message ?? error));
const blockedMessage = '公開範囲または接続を確認できないため、以前の表示を消しました。公開範囲を再確認してください。';
const fileLabels = {A: '追加', M: '変更', D: '削除', T: '種類変更', R: '名前変更', C: 'コピー'};
let nextId = 0;

/** Read-only public Git history. The caller owns account-bound invoke and calls invalidate on connection changes. */
export function researchGitBrowser(target, {projectId, oid, base}, options = {}) {
  const document = target.ownerDocument, container = options.state ?? {}, state = container.gitBrowser ??= {}, root = node(document, 'section', null, 'research-git-browser detail-form');
  const scope = JSON.stringify([projectId, options.publicRepository ?? null, options.signedIn ?? null]);
  if (state.scope !== scope) { for (const key of Object.keys(state)) delete state[key]; state.scope = scope; }
  state.details ??= {};
  let comparisonBase=base??(oid===undefined?state.base??'':'');state.base=comparisonBase;
  const cacheKey=next=>comparisonBase?`${comparisonBase}:${next}`:next;
  let active = true, allowed = options.publicRepository === true, historyPending = false, detailPending = false, pendingOid = '', historyRevision = 0, detailRevision = 0, selected = oid ?? (Array.isArray(options.prepared?.commits) ? '' : state.selected ?? ''), historyError = '', detailError = '', focusSelection = false;
  const listeners = [], cancellations = new Set(), verifiedDetails = new WeakSet();
  const historyId = `research-git-history-${++nextId}`, selection = node(document, 'section', null, 'research-git-selection detail-form');
  selection.tabIndex = -1; selection.setAttribute('aria-label', '選択したコミット');
  const listHost = node(document, 'div', null, 'research-git-history detail-form'); listHost.id = historyId;
  const toggle = button('最近のコミットを表示', () => { state.historyExpanded = !state.historyExpanded; renderHistory(); });
  toggle.setAttribute('aria-controls', historyId);
  if (state.historyExpanded === undefined) state.historyExpanded = !oidValid(selected);
  state.selected = selected;
  function on(element, type, run, requiresPublic = true) { const wrapped = event => { if (active && (!requiresPublic || allowed)) run(event); }; element.addEventListener(type, wrapped); listeners.push([element, type, wrapped]); }
  function button(label, run, requiresPublic = true) { const result = node(document, 'button', label, 'head-action'); result.type = 'button'; on(result, 'click', run, requiresPublic); return result; }
  function anchor(label, value) {
    const result = node(document, 'a', label); result.href = value;
    if (options.openWeb) on(result, 'click', event => { event.preventDefault(); options.openWeb(value); });
    return result;
  }
  function errorMessage(error, name) {
    if (error?.message === 'invalid_git_response') return `${name}の応答が表示対象と一致しないか、表示上限を超えています。再読み込みしてください。`;
    return options.friendlyError?.(error) || `${name}を読み込めませんでした。再読み込みしてください。`;
  }
  function empty(message) { return node(document, 'p', message, 'meta'); }
  function status(message) { const result = empty(message); result.setAttribute('role', 'status'); return result; }
  function renderHistory() {
    if (!active || !allowed) return;
    toggle.textContent = state.historyExpanded ? '履歴をたたむ' : '最近のコミットを表示'; toggle.setAttribute('aria-expanded', String(state.historyExpanded));
    listHost.hidden = !state.historyExpanded;
    const children = [empty('最新20件のコミットを表示します。')];
    if (historyPending) children.push(status('履歴を読み込み中…'));
    if (historyError) children.push(status(historyError + (state.history ? ' 最新の状態を確認できませんでした。前回取得した履歴を表示しています。' : '')));
    if (state.history) {
      const list = node(document, 'ul', null, 'research-git-history-list');
      for (const commit of state.history.commits) {
        const item = node(document, 'li'), full = `${commit.subject || '件名なし'} · ${commit.oid.slice(0, 12)}`, pick = button(`${clipped(commit.subject) || '件名なし'} · ${commit.oid.slice(0, 12)}`, () => choose(commit.oid));
        pick.classList.add('research-git-history-subject'); pick.title = full; pick.setAttribute('aria-label', full); if (commit.oid === selected) pick.setAttribute('aria-current', 'true');
        item.append(pick, empty(commit.committedAt)); list.append(item);
      }
      children.push(state.history.commits.length ? list : empty('コミットはまだありません。'));
    }
    const retry = button('履歴を再読み込み', () => { void loadHistory(); }); retry.disabled = historyPending; children.push(retry); listHost.replaceChildren(...children);
  }
  function renderDetail() {
    if (!active || !allowed) return;
    const children = [node(document, 'h4', '選択したコミット')];
    if (!selected) children.push(empty('履歴からコミットを選択してください。'));
    else if (!oidValid(selected)) children.push(status('コミットは40桁または64桁の小文字の16進数で指定してください。'));
    else {
      if (detailPending) children.push(status('コミットを読み込み中…'));
      if (detailError) children.push(status(detailError + (state.details[cacheKey(selected)] ? ' 最新の状態を確認できませんでした。前回取得したコミットを表示しています。' : '')));
      const saved = state.details[cacheKey(selected)];
      if (saved) {
        const {commit, files, diff, truncated} = saved;
        const subject = node(document, 'h5', clipped(commit.subject) || '件名なし'); subject.title = commit.subject; subject.setAttribute('aria-label', commit.subject || '件名なし');
        children.push(subject, node(document, 'code', commit.oid, 'research-source'), empty(commit.committedAt), anchor(saved.baseOid?'二つの版の比較URL':'このコミットのURL', href(projectId, selected,saved.baseOid)));
        const reference=contentShareReference(href(projectId,commit.oid,saved.baseOid));
        if(reference?.kind==='git'&&verifiedDetails.has(saved)&&typeof options.shareContent==='function'){
          const selectedAtStart=selected,baseAtStart=comparisonBase,revision=detailRevision,historyAtStart=historyRevision,key=cacheKey(selected),title=clipped(commit.subject)||'コードの変更';let busy=false;
          const share=button('投稿で紹介',async()=>{
            if(busy||!current())return;busy=true;share.disabled=true;
            try{if(await options.shareContent({href:reference.href,title,isCurrent:current})===false&&current())notice.textContent='紹介先を開けません。もう一度試してください。';}
            catch{if(current())notice.textContent='紹介先を開けません。もう一度試してください。';}
            finally{busy=false;if(current())share.disabled=false;}
          });
          const current=()=>active&&allowed&&state.scope===scope&&container.gitBrowser===state&&!detailPending&&!historyPending&&!detailError&&!historyError&&revision===detailRevision&&historyAtStart===historyRevision&&selected===selectedAtStart&&comparisonBase===baseAtStart&&state.details[key]===saved&&options.isCurrent?.()!==false&&root.isConnected&&root.parentNode===target&&selection.contains(share)&&share.isConnected;
          const notice=status('');share.disabled=detailPending||historyPending||Boolean(detailError||historyError);children.push(share,notice);
        }
        const useBase=button('このコミットを比較の基準にする',()=>setBase(selected));useBase.disabled=selected===comparisonBase;children.push(useBase);
        options.onComparison?.(saved.baseOid?saved:null);
        if(saved.baseOid&&saved.baseOid!==selected&&options.openGitProposals){const propose=button('比較した二版をGit提案にする',()=>options.openGitProposals(projectId,saved));propose.disabled=options.signedIn===false;children.push(propose);}
        const parents = node(document, 'nav', null, 'detail-form'); parents.setAttribute('aria-label', '親コミット');
        for (const parent of commit.parentOids) parents.append(button(`親コミットを見る · ${parent.slice(0, 12)}`, () => choose(parent)), anchor(`親コミットのURL · ${parent.slice(0, 12)}`, href(projectId, parent)));
        children.push(commit.parentOids.length ? parents : empty('親コミットのない最初のコミットです。'));
        if (options.openDiscussion) {
          const discuss = button('この変更について議論する', () => options.openDiscussion(projectId, selected)); discuss.disabled = options.signedIn === false; children.push(discuss);
          if (options.signedIn === false) children.push(empty('議論するにはHubに接続してログインしてください。'));
        }
        children.push(node(document, 'h5', 'コミットメッセージ'), node(document, 'pre', commit.message, 'research-source'), node(document, 'h5', '変更ファイル'));
        if (files.length) {
          const list = node(document, 'ul', null, 'research-git-files');
          for (const file of files) { const item = node(document, 'li'); item.append(node(document, 'span', `${fileLabels[file.status[0]]} (${file.status}) · `), node(document, 'code', file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)); list.append(item); }
          children.push(list);
        } else children.push(empty('表示できるファイル変更はありません。'));
        children.push(node(document, 'h5', '差分'), empty(saved.baseOid?`基準 ${saved.baseOid} と変更後 ${selected} の直接の差分です。マージ可能性は検証しません。`:'差分は最初の親コミットとの比較です。最初のコミットは追加内容を表示します。'));
        if (truncated) children.push(empty('表示上限のため、変更説明・ファイル一覧・差分の一部を省略しています。全体はGitでこのコミットを取得して確認してください。'));
        children.push(diff ? node(document, 'pre', diff, 'research-source') : empty('表示できるテキスト差分はありません。'));
        if(saved.baseOid&&saved.baseOid!==selected){const transfer=node(document,'details');transfer.append(node(document,'summary','別のHubへこの変更を渡す'),empty('二版のファイル変更をバイナリ込みのGitパッチで保存します（最大16MiB）。画面で省略された差分も含みます。履歴・提案理由・レビュー結果は含みません。'),anchor('二版の変更パッチをダウンロード',`/api/research/projects/${encodeURIComponent(projectId)}/git/patch?base=${saved.baseOid}&head=${selected}`),empty('受け取った側は同じ基準版の作業用コピーで内容と利用条件を確認し、Gitで適用可否を確かめてから適用してください。Hubはコードを実行・反映しません。P2Pのファイル送信でも渡せます。'),node(document,'pre','git apply --check CHANGE.patch\ngit apply --index CHANGE.patch','research-source'),empty('変更後に自分のHubへpushし、そのHubの提案・レビューへ進めます。コミットID・履歴の複製にはGit bundleを使ってください。LFSの実体とサブモジュールの中身は含みません。'));children.push(transfer);}
      }
      const retry = button('このコミットを再読み込み', () => { void loadDetail(selected); }); retry.disabled = detailPending; children.push(retry);
    }
    selection.replaceChildren(...children);
    if (focusSelection) { selection.focus({preventScroll: true}); selection.scrollIntoView?.({block: 'start'}); focusSelection = false; }
  }
  function choose(next) {
    if (!active || !allowed || !oidValid(next)) return;
    options.onComparison?.(null);
    if (comparisonBase&&options.openComparison){options.openComparison(projectId,next,comparisonBase);return;}
    if (options.openCommit&&!comparisonBase) { options.openCommit(projectId, next); return; }
    selected = state.selected = next; state.historyExpanded = false; detailError = ''; focusSelection = true;
    renderHistory(); renderDetail(); void loadDetail(next);
  }
  function setBase(value){if(!active||!allowed||value&&(!oidValid(value)||oidValid(selected)&&value.length!==selected.length))return;options.onComparison?.(null);comparisonBase=state.base=value;delete state.details[cacheKey(selected)];if(oidValid(selected)){if(value&&options.openComparison){options.openComparison(projectId,selected,value);return;}if(!value&&options.openCommit){options.openCommit(projectId,selected);return;}void loadDetail(selected);}renderComparison();renderDetail();}
  const comparisonControls=node(document,'section',null,'detail-form');
  function renderComparison(){const form=node(document,'form'),label=node(document,'label','比較の基準コミット'),input=node(document,'input');input.value=comparisonBase;input.maxLength=64;input.setAttribute('aria-label','比較の基準コミット');label.append(input);const apply=node(document,'button','この版を比較の基準にする','head-action');apply.type='submit';on(form,'submit',event=>{event.preventDefault();if(!oidValid(input.value)||oidValid(selected)&&input.value.length!==selected.length){notice.textContent='同じ形式の完全な40桁または64桁のIDを指定してください。';return;}setBase(input.value);});const notice=status('');form.append(label,apply,notice);comparisonControls.replaceChildren(form);if(comparisonBase)comparisonControls.append(node(document,'code',comparisonBase,'research-source'),button('二版の比較を終了',()=>setBase('')));}
  async function request(args) {
    let timer, cancel;
    try { return await Promise.race([Promise.resolve().then(() => { if (!active) throw new Error('git_read_cancelled'); return options.invoke('hub_detail', args); }), new Promise((_, reject) => { cancel = () => reject(new Error('git_read_cancelled')); cancellations.add(cancel); timer = setTimeout(() => reject(new Error('git_read_timeout')), 20000); })]); }
    finally { clearTimeout(timer); cancellations.delete(cancel); }
  }
  async function loadHistory() {
    if (!active || !allowed || historyPending) return;
    const revision = ++historyRevision; historyPending = true; historyError = ''; renderHistory(); renderDetail();
    try { const data = history(await request({name: 'research_git_history', ids: [projectId]}), projectId); if (active && revision === historyRevision) state.history = data; }
    catch (error) { if (active && revision === historyRevision) { if (readDenied(error)) revokeRead(); else historyError = errorMessage(error, 'コミット一覧'); } }
    finally { if (active && revision === historyRevision) { historyPending = false; renderHistory(); renderDetail(); } }
  }
  async function loadDetail(next) {
    if (!active || !allowed || !oidValid(next) || (detailPending && pendingOid === cacheKey(next))) return;
    const revision = ++detailRevision,baseAtStart=comparisonBase,key=cacheKey(next); detailPending = true; pendingOid = key; detailError = ''; renderDetail();
    try { const data = detail(await request({name: baseAtStart?'research_git_compare':'research_git_commit', ids: baseAtStart?[projectId,next,baseAtStart]:[projectId, next]}), projectId, next,baseAtStart||undefined); if (active && revision === detailRevision && selected === next&&comparisonBase===baseAtStart) {state.details[key] = data;verifiedDetails.add(data);} }
    catch (error) { if (active && revision === detailRevision && selected === next) { if (readDenied(error)) revokeRead(); else detailError = errorMessage(error, 'コミット'); } }
    finally { if (active && revision === detailRevision && selected === next) { detailPending = false; renderDetail(); } }
  }
  let preparedHistory = false, preparedDetail = false, preparedRejected = state.blocked === true;
  if (!preparedRejected && options.prepared !== undefined && options.publicRepository !== false) {
    try {
      if (selected && oidValid(selected)) { const parsed=detail(options.prepared, projectId, selected,comparisonBase||undefined);state.details[cacheKey(selected)] = parsed;verifiedDetails.add(parsed); preparedDetail = true; }
      else if (!selected) { state.history = history(options.prepared, projectId); preparedHistory = true; }
      else invalid();
      allowed = true;
    } catch (error) { preparedRejected = true; if (selected) detailError = errorMessage(error, 'コミット'); else historyError = errorMessage(error, 'コミット一覧'); }
  }
  const title = node(document, 'h3', 'Gitの変更履歴');
  function mountReader() { root.replaceChildren(title, comparisonControls,selection, toggle, listHost);renderComparison(); renderHistory(); renderDetail(); }
  function revokeRead() {
    allowed = false; ++historyRevision; ++detailRevision; historyPending = detailPending = false;
    delete state.history; state.details = {}; state.blocked = true;
    options.onComparison?.(null);
    for (const cancel of cancellations) cancel(); cancellations.clear();
    showRecovery(blockedMessage);
  }
  function showRecovery(message) {
    const notice = status(message), retry = button('公開範囲を再確認して読み込み', async () => {
      if (retry.disabled || (selected && !oidValid(selected))) return;
      retry.disabled = true; notice.textContent = '公開範囲を再確認中…';
      try {
        const args = {name: selected ? comparisonBase?'research_git_compare':'research_git_commit' : 'research_git_history', ids: selected ? comparisonBase?[projectId,selected,comparisonBase]:[projectId, selected] : [projectId]};
        const response = await request(args), verified = selected ? detail(response, projectId, selected,comparisonBase||undefined) : history(response, projectId);
        if (!active) return;
        if (selected) {state.details[cacheKey(selected)] = verified;verifiedDetails.add(verified);} else state.history = verified;
        allowed = true; preparedRejected = false; delete state.blocked; historyError = detailError = ''; mountReader();
      } catch (error) { if (active) notice.textContent = errorMessage(error, selected ? 'コミット' : 'コミット一覧'); }
      finally { if (active) retry.disabled = false; }
    }, false);
    retry.disabled = Boolean(selected && !oidValid(selected)); root.replaceChildren(title, notice, retry);
  }
  if (preparedRejected) showRecovery(state.blocked ? blockedMessage : detailError || historyError);
  else if (!allowed) root.append(title, status('公開リポジトリの変更履歴を閲覧できます。このリポジトリは非公開か、公開範囲を確認できないため表示できません。'));
  else mountReader();
  target.append(root);
  const ready = allowed && !preparedRejected ? Promise.all([preparedHistory || state.history ? Promise.resolve() : loadHistory(), preparedDetail || !oidValid(selected) || state.details[cacheKey(selected)] ? Promise.resolve() : loadDetail(selected)]) : Promise.resolve();
  function dispose() {
    if (!active) return; active = false; ++historyRevision; ++detailRevision;
    options.onComparison?.(null);
    for (const [element, type, run] of listeners) element.removeEventListener(type, run);
    for (const cancel of cancellations) cancel(); cancellations.clear();
  }
  function invalidate() { dispose(); for (const key of Object.keys(state)) delete state[key]; root.replaceChildren(status('接続が変わりました。公開範囲をもう一度確認してください。')); }
  return {root, ready, dispose, invalidate};
}





