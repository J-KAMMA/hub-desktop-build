export function initBrowserPanels({ document, window, invoke, button, report, refresh, hideSuggestions,beforePanelOpen=()=>true, getActiveTab, getView=()=> 'browser', beforeDownloadHistory=()=>true }) {
  const menu = document.querySelector('#browser-menu');
  const pending = document.createElement('section'); pending.id = 'browser-permissions'; pending.hidden = true; pending.setAttribute('aria-label', 'サイトからの権限要求');
  menu.after(pending);
  const session = document.createElement('div'); session.id='browser-session-notice'; session.hidden=true; pending.after(session);
  let tabs=[];
  const downloadButton = button('', () => showDownloads(), 'browser-download-button'); downloadButton.id = 'browser-downloads'; downloadButton.title = 'ダウンロード'; downloadButton.setAttribute('aria-label', 'ダウンロード');
  downloadButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg><span class="browser-download-badge" hidden></span>';
  document.querySelector('#browser-tools').before(downloadButton);
  let sessionCount = 0, downloads = [], requests = [], generation = 0, mode = '', downloadError = '', downloadStale = false;
  const downloadPending = new Set(), downloadErrors = new Map();
  let panelTurn=0;
  let historyOperation=null,historyError='',tabScope={};
  const historySource=()=>{const tab=getActiveTab?getActiveTab():tabs.find(tab=>tab.active);return getView()==='browser'&&Number.isSafeInteger(tab?.id)&&tab.id>0&&typeof tab.private==='boolean'?{id:tab.id,private:tab.private,url:tab.url,epoch:tab.epoch,scope:tabScope}:null;};
  const sameHistorySource=(a,b)=>Boolean(a&&b&&a.id===b.id&&a.private===b.private&&a.url===b.url&&a.epoch===b.epoch&&a.scope===b.scope);
  const historyCurrent=source=>sameHistorySource(source,historySource());
  const historyBlocked=source=>historyOperation?.pending||sameHistorySource(source,historyOperation?.source)&&historyOperation?.unknown;
  async function openDownloadHistory(source) {
    if(!historyCurrent(source)||historyBlocked(source))return;
    const operation={source,pending:true,unknown:false};historyOperation=operation;historyError='';
    if(mode==='downloads'&&!menu.hidden)renderDownloads();
    let sent=false;
    try {
      if(await beforePanelOpen()===false||!historyCurrent(source))return;
      hideSuggestions();mode='';++panelTurn;menu.hidden=true;
      if(await beforeDownloadHistory(()=>historyCurrent(source))===false||!historyCurrent(source))return;
      sent=true;
      const value=await invoke('browser_download_history',{expectedTabId:source.id});
      if(!historyCurrent(source))return;
      if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==3||!['tabId','open','private'].every(key=>Object.hasOwn(value,key))||value.tabId!==source.id||value.open!==true||value.private!==source.private)throw Error('download_history_unknown');
    } catch(error) {
      if(!historyCurrent(source))return;
      const code=String(error?.message??error),known=['invalid_request','main_required','busy','scope_changed','not_visible','profile_mismatch','unsupported','unavailable'].some(value=>code===`download_history_${value}`);
      operation.unknown=sent&&!known;
      historyError=code==='download_history_unsupported'?'この環境ではプロフィールのダウンロード履歴を開けません。':code==='download_history_busy'?'進行中・一時停止中のダウンロードはHubの一覧で操作してください。':operation.unknown?'履歴画面を開けたか確認できません。ブラウザの表示を確認してください。':'現在のタブでダウンロード履歴を開けませんでした。';
      report(Error(known?code:'download_history_unknown'));
    } finally {
      operation.pending=false;
      if(historyOperation===operation&&!operation.unknown)historyOperation=null;
      if(historyCurrent(source)&&mode==='downloads'&&!menu.hidden)renderDownloads();
    }
  }
  const downloadStates = new Set(['choosing','active','paused','interrupted','complete','failed','cancelled']);
  const resumableReasons = new Set([12,13,14,15,28]);
  const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && value.trim() && !/[\u0000-\u001f\u007f-\u009f/\\:]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) ? value : 'ダウンロード';
  function checkedDownloads(value) {
    if (!Array.isArray(value) || value.length > 100) throw Error('invalid_downloads');
    const counts = new Map();for(const row of value)if(Number.isSafeInteger(row?.id)&&row.id>0)counts.set(row.id,(counts.get(row.id)??0)+1);
    return value.map(raw => {
      const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const validId = Number.isSafeInteger(row.id) && row.id > 0 && counts.get(row.id)===1;
      return {id:validId?row.id:null,name:safeName(row.name),received:safeCount(row.received),total:safeCount(row.total),status:downloadStates.has(row.status)?row.status:'unknown',canResume:row.canResume===true,choosingDestination:typeof row.choosingDestination==='boolean'?row.choosingDestination:null,interruptReason:Number.isSafeInteger(row.interruptReason)&&row.interruptReason>=0&&row.interruptReason<=2147483647?row.interruptReason:null};
    });
  }
  const kind = value => ({1:'マイク',2:'カメラ',3:'位置情報',4:'通知',5:'センサー',6:'クリップボードの読み取り',7:'複数ファイルの自動ダウンロード',8:'ファイルの読み書き',9:'自動再生',10:'フォント',11:'MIDI',12:'ウィンドウ管理'})[value] ?? '追加のサイト権限';
  const status = value => ({ choosing:'保存先を選択中',active:'ダウンロード中',paused:'一時停止中',interrupted:'ダウンロードが中断しました',complete:'完了',failed:'中断・失敗',cancelled:'キャンセル',unknown:'状態を確認できません',pending:'確認待ち',allowed:'今回のみ許可',denied:'拒否' })[value] ?? value;
  const line = text => { const node = document.createElement('p'); node.className = 'browser-menu-empty'; node.textContent = text; return node; };
  const bytes = value => value === null ? '不明' : value < 1024 ? `${value} B` : value < 1048576 ? `${(value/1024).toFixed(1)} KB` : `${(value/1048576).toFixed(1)} MB`;
  const canResume = row => ['paused','interrupted'].includes(row.status) && row.canResume && resumableReasons.has(row.interruptReason);
  const allowed = (row,command) => row && row.id !== null && !downloadStale && row.choosingDestination!==true && (command==='browser_save_download'?row.status==='choosing'&&row.choosingDestination===false:command==='browser_pause_download'?row.status==='active':command==='browser_resume_download'?canResume(row):command==='browser_cancel_download'?['choosing','active','paused','interrupted'].includes(row.status):['browser_reveal_download','browser_open_download'].includes(command)&&row.status==='complete');
  const actionErrors = new Map([['download_open_blocked','安全のため、この種類のファイルはHubから開きません。「フォルダーで確認」から開いてください。'],['download_file_missing','ファイルが見つかりません。移動または削除された可能性があります。'],['download_not_complete','ダウンロードが終わってから開いてください。'],['download_open_failed','ファイルを開けませんでした。'],['download_destination_busy','保存先の選択を完了してください。'],['download_not_active','ダウンロードの状態が変わりました。現在の状態を確認してください。'],['download_not_resumable','現在このダウンロードは再開できません。'],['download_unavailable','このダウンロードは現在操作できません。'],['download_operation_failed','ダウンロードの操作結果を確認できませんでした。']]);
  const actionError = error => actionErrors.get(String(error?.message??error)) ?? 'ダウンロードの操作結果を確認できませんでした。状態を更新して確認してください。';
  async function downloadAction(id,command,args={}) {
    if(downloadPending.has(id)||!allowed(downloads.find(row=>row.id===id),command))return;
    downloadPending.add(id);downloadErrors.delete(id);if(mode==='downloads'&&!menu.hidden)renderDownloads();
    try { const result=await invoke(command,{id,...args});if(command==='browser_save_download'&&(!result||Object.keys(result).length!==2||result.id!==id||result.queued!==true))throw Error('download_outcome_unknown'); }
    catch(error) { downloadErrors.set(id,actionError(error)); }
    finally { try{await load();}finally{downloadPending.delete(id);if(mode==='downloads'&&!menu.hidden)renderDownloads();} }
  }
  function downloadControl(row,label,command,args) {
    const control=button(label,()=>downloadAction(row.id,command,args));control.disabled=downloadPending.has(row.id)||!allowed(row,command);return control;
  }
  const permissionPending=new Set();
  function requestCurrent(row){const active=tabs.find(tab=>tab.active);try{return active?.id===row.tab&&new URL(active.url).origin===row.top_origin;}catch{return false;}}
  const permissionValid=row=>row&&Number.isSafeInteger(row.id)&&row.id>0&&Number.isSafeInteger(row.tab)&&row.tab>0&&typeof row.origin==='string'&&row.origin.length<=512&&typeof row.top_origin==='string'&&row.top_origin.length<=512;
  async function reply(id,allow,remember=false){
    const row=requests.find(item=>item.id===id);
    if(!permissionValid(row)||row.status!=='pending'||permissionPending.has(id)||allow&&!requestCurrent(row))return;
    permissionPending.add(id);renderPending();
    try{await invoke('browser_permission_reply',remember?{id,allow,remember:true}:{id,allow});await load();}
    finally{permissionPending.delete(id);renderPending();}
  }
  // 一度閉じた案内は出さない（復元はメニューからいつでもできる）。2026-10-11 ユーザー指定。
  const SESSION_NOTICE_KEY='hub.browser.session-notice-dismissed';
  const sessionNoticeDismissed=()=>{try{return window.localStorage.getItem(SESSION_NOTICE_KEY)==='1';}catch{return false;}};
  function renderSession() {
    session.replaceChildren(); session.hidden=!(sessionCount && tabs.length <= 1 && tabs.every(tab=>!tab.url&&!tab.pinned)) || sessionNoticeDismissed();
    if(!session.hidden)session.append(line(`前回の ${sessionCount} タブをこのPCに保存しています。`),button('前回のタブを復元',async()=>{await invoke('browser_restore_session');await refresh();await load();}),
      button('閉じる',()=>{try{window.localStorage.setItem(SESSION_NOTICE_KEY,'1');}catch{}session.hidden=true;session.replaceChildren();}));
  }
  function renderPending() {
    pending.replaceChildren(); const rows = requests.filter(row => permissionValid(row)&&row.status === 'pending'); pending.hidden = !rows.length;
    for (const row of rows) {
      const item=document.createElement('div');item.className='browser-permission-request';
      const tab=tabs.find(tab=>tab.id===row.tab),active=requestCurrent(row);
      const rememberLabel=document.createElement('label'),remember=document.createElement('input');remember.type='checkbox';rememberLabel.className='browser-permission-remember';rememberLabel.append(remember,document.createTextNode(' このサイトでは次から聞かない'));
      const deny=button('拒否',()=>reply(row.id,false,remember.checked)),allow=button('許可',()=>reply(row.id,true,remember.checked));
      deny.disabled=permissionPending.has(row.id);allow.disabled=!active||permissionPending.has(row.id);
      item.append(line(`${row.origin} が ${kind(row.kind)}を求めています。`),line(`要求元のタブ: ${tab?.title||'別のタブ'} · ${row.top_origin}`));
      if(!active)item.append(line('許可するには要求元のタブを表示してください。'));
      item.append(rememberLabel,deny,allow);pending.append(item);
    }
  }
  function renderDownloads() {
    menu.replaceChildren(); menu.append(line('ダウンロード · 保存先はファイルごとに選択します'),line('再開すると受信済みの部分を最初から取得する場合があります。一時停止・再開はこの起動中だけ利用でき、アプリの再起動後は引き継げません。'));
    const source=historySource(),history=button('プロフィールのダウンロード履歴',()=>openDownloadHistory(source));history.disabled=!source||Boolean(historyBlocked(source));menu.append(history,line('過去の履歴は現在のブラウザプロフィールに保存されています。プライベートはそのプロフィールだけ。'));
    if(historyError){const message=line(historyError);message.setAttribute('role','status');menu.append(message);}
    if(downloadError){const error=line(downloadError);error.setAttribute('role','status');menu.append(error,button('再取得',()=>load()));}
    if (!downloads.length) menu.append(line('この起動中のダウンロードはありません。'));
    for (const row of [...downloads].reverse()) {
      const item = document.createElement('div'); item.className = 'browser-download-row';
      const label = line(`${row.name} · ${status(row.status)} · ${bytes(row.received)}${row.total > 0 ? ` / ${bytes(row.total)}` : ''}`); item.append(label);
      if (row.status === 'choosing') {
        for (const [location,label] of [['downloads','ダウンロードフォルダーに保存'],['choose','場所を選ぶ']]) item.append(downloadControl(row,label,'browser_save_download',{location}));
      }
      if (row.status === 'active') { const progress = document.createElement('progress'); if (row.total > 0 && row.received !== null) { progress.max = row.total; progress.value = Math.min(row.total,row.received); } progress.setAttribute('aria-label', `${row.name}の進行`); item.append(progress,downloadControl(row,'一時停止','browser_pause_download')); }
      if (['paused','interrupted'].includes(row.status)) { if(canResume(row))item.append(downloadControl(row,'再開','browser_resume_download'));else item.append(line('現在このダウンロードは再開できません。状態を再取得して確認してください。')); }
      if (['active','choosing','paused','interrupted'].includes(row.status)) item.append(downloadControl(row,'キャンセル','browser_cancel_download'));
      if (row.status === 'complete') item.append(downloadControl(row,'開く','browser_open_download'),downloadControl(row,'フォルダーで確認','browser_reveal_download'));
      if(downloadPending.has(row.id)||row.choosingDestination===true){item.setAttribute('aria-busy','true');item.append(line(row.choosingDestination===true?'保存先の選択を完了してください。':'操作結果を確認しています…'));}
      if(downloadErrors.has(row.id)){const error=line(downloadErrors.get(row.id));error.setAttribute('role','status');item.append(error);}
      menu.append(item);
    }
    menu.append(button('状態を更新',()=>load()),button('閉じる', () => { mode=''; menu.hidden=true; }));
  }
  function showDownloads() { const turn=++panelTurn,ready=beforePanelOpen();if(ready&&typeof ready.then==='function')return ready.then(ok=>{if(turn===panelTurn&&ok!==false)openDownloads();});if(ready!==false)openDownloads(); }
  function openDownloads() {hideSuggestions();mode='downloads';menu.hidden=false;renderDownloads();}
  function showPermissions() {const turn=++panelTurn,ready=beforePanelOpen();if(ready&&typeof ready.then==='function')return ready.then(ok=>{if(turn===panelTurn&&ok!==false)openPermissions();});if(ready!==false)openPermissions();}
  function openPermissions() {
    hideSuggestions(); mode=''; menu.hidden=false; menu.replaceChildren(); menu.append(line('サイト権限 · 許可は今回の要求だけに適用します。未回答の要求は60秒で拒否します。'));
    for (const row of [...requests].reverse()) menu.append(line(`${row.origin} · ${kind(row.kind)} · ${status(row.status)}`));
    if (!requests.length) menu.append(line('この起動中の権限要求はありません。'));
    menu.append(button('閉じる', () => {menu.hidden=true;}));
  }
  function addTools(host) {
    mode='';
    const restore = button(sessionCount ? `前回のタブを復元 (${sessionCount})` : '前回のタブはありません', async () => { await invoke('browser_restore_session'); menu.hidden=true; await refresh(); await load(); }); restore.disabled=!sessionCount;
    host.append(restore, button('ダウンロード', showDownloads), button('サイト権限', showPermissions));
    const note=line('拡張機能：現在は未対応です。追加・実行できる拡張機能はありません。'); host.append(note);
  }
  async function load() {
    const turn=++generation;
    const results=await Promise.allSettled([invoke('browser_session_status'),invoke('browser_downloads'),invoke('browser_site_requests')]);
    if(turn!==generation)return;
    if(results[0].status==='fulfilled')sessionCount=results[0].value;
    if(results[1].status==='fulfilled') { try{downloads=checkedDownloads(results[1].value);downloadError='';downloadStale=false;}catch{downloads=[];downloadStale=true;downloadError='ダウンロードの状態を確認できませんでした。';} }
    else {downloadStale=true;downloadError='ダウンロードの状態を再取得できませんでした。';}
    for(const id of downloadErrors.keys())if(!downloadPending.has(id)&&!downloads.some(row=>row.id===id))downloadErrors.delete(id);
    requests=results[2].status==='fulfilled'&&Array.isArray(results[2].value)&&results[2].value.length<=100?results[2].value.filter(permissionValid):[];
    {const running=downloads.filter(row=>['active','choosing'].includes(row.status)).length,badge=downloadButton.querySelector('.browser-download-badge'),label=running?`ダウンロード（進行中 ${running} 件）`:'ダウンロード';
      if(badge){badge.hidden=running===0;badge.textContent=running===0?'':running>9?'9+':String(running);}
      downloadButton.title=label;downloadButton.setAttribute('aria-label',label);}
    renderPending(); renderSession();
    if(downloads.some(row=>row.status==='choosing') && !requests.some(row=>row.status==='pending')) await showDownloads();
    else if(mode==='downloads'&&!menu.hidden)renderDownloads();
  }
  window.__TAURI__.event.listen('browser-access-changed',()=>void load().catch(report));
  void load().catch(report);
  return {addTools,showPermissions,showDownloads,load,updateTabs:value=>{const old=tabs.find(tab=>tab.active),next=Array.isArray(value)?value:[],active=next.find(tab=>tab.active);if(old?.id!==active?.id||old?.url!==active?.url||old?.private!==active?.private){tabScope={};historyError='';}tabs=next;renderSession();renderPending();if(mode==='downloads'&&!menu.hidden)renderDownloads();},closeMode:()=>{mode='';++panelTurn;}};
}
