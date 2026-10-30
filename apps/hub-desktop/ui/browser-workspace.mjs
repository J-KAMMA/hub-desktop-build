import { attachAddressSelectAll } from './address-select-all.mjs';
import {createBrowserVerticalTabs} from './browser-vertical-tabs.mjs';
import { faviconImage } from './browser-favicon.mjs';
import { createBrowserBookmarkBar } from './browser-bookmark-bar.mjs';
import {createBrowserProtection} from './browser-protection-ui.mjs';
import {createBrowserAutoplay} from './browser-autoplay-ui.mjs';
import { initBrowserPanels } from './browser-panels.mjs';
import { renderBrowserLibrary } from './browser-library.mjs';
import { renderBrowserPrivacy } from './browser-privacy.mjs';
import { initBrowserReader } from './browser-reader.mjs';
import { SEARCH_ENGINES, navigationTarget, addressSuggestions, browserShortcut, pageUrl, filterBrowserTabs, completeDotCom, selectionSearchUrl } from './browser-navigation.mjs';

export function initBrowserWorkspace({ document, window, invoke, icon, enterBrowser, isActive, getView, onAiDraft, onHubSearch, getHubHistory, onHubHistory, onLocalGames = () => {}, metrics = { begin: () => () => {} } }) {
  const $ = selector => document.querySelector(selector);
  const input = $('#browser-url'), menu = $('#browser-menu'), error = $('#browser-error');
  attachAddressSelectAll(input);
  const suggestions = $('#browser-suggestions'), findBar = $('#browser-find-bar');
  const tabInput = $('#sidebar-tab-query');
  let composing = false, tabComposing = false, tabQuery = '', tabIndex = 0, renderTabResults = () => {}, focusGeneration = 0, pendingNewTab = null, menuGeneration = 0;
  let pendingSelect = null, lastSelectRequest = 0, renderedGeneration = 0, settledGeneration = 0;
  let pendingRefresh = null, lastRefreshRequest = 0;
  let nativeDraftTab = null, nativeEditTurn = 0;
  let addressDraftTab = null;
  let activeTabIdentity = {};
  let nativeChrome = false, nativeChromeGeneration = 0, pendingNativeAddress = null;
  let probeProfile = 1, probeRequest = 0, refreshesInFlight = 0, selectionsInFlight = 0, fallbackCount = 0;
  let tabs = [], favorites = [], history = [], engine = 'google', generation = 0, suggestionIndex = -1, candidates = [], menuKind = 'history', dragging = null;
  let collapsedGroups = new Set();
  try { const saved = JSON.parse(window.localStorage.getItem('hub.browser.collapsedGroups')); if (Array.isArray(saved)) collapsedGroups = new Set(saved.filter(name => typeof name === 'string' && name.length <= 160)); } catch { /* optional preference */ }
  try { const saved = window.localStorage.getItem('hub.browser.searchEngine'); if (Object.hasOwn(SEARCH_ENGINES, saved)) engine = saved; } catch { /* optional preference */ }
  let privacyPanel = null, reader = null;
  let privateNewPending=false,findReader=false,findRevision=0;
  let browserControlEpoch = 0, printPending = false, printCheckPending = false, controlsStale = true;
  const mutePending = new Set();
  const active = () => tabs.find(tab => tab.active);
  const button = (label, fn, className = 'browser-menu-tab') => {
    const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label;
    node.onclick = event => void Promise.resolve(fn(event)).catch(report); return node;
  };
  function report(reason) {
    const code = String(reason);
    if (code.includes('hub_origin_blocked')) return;
    error.textContent = code.includes('invalid_url') ? 'Webアドレスを確認してください。http / https のページを開けます。'
      : code.includes('private_unavailable') ? 'この環境では安全なプライベート閲覧を開始できません。通常のタブには切り替えていません。'
      : code.includes('invalid_find_query') ? '検索語は200文字以内、制御文字を含めず入力してください。'
      : code.includes('invalid_tab_group') ? 'グループ名は80文字以内で入力してください。'
      : code.includes('tab_group_limit') ? 'グループは16個まで作成できます。既存のグループを選んでください。'
      : code.includes('bookmark_limit_exceeded') ? 'お気に入りは1,000件まで保存できます。整理してから取り込んでください。'
      : code.includes('bookmark_') ? 'お気に入りの操作を完了できませんでした。ファイルや入力内容を確認してください。'
      : code.includes('session_write_failed') ? 'タブ情報を保存できませんでした。空き容量と保存先を確認してください。'
      : code.includes('tab_pinned') ? '固定したタブです。固定を解除してから閉じてください。'
      : code.includes('no_closed_tab') ? '復元できるタブはありません。'
      : code.includes('ai_work_busy') ? 'AIの送信・操作中です。処理が終わってから下書きを追加してください。'
      : code.includes('ai_work_unavailable') ? 'AIの作業画面を準備しています。準備が終わってから下書きを追加してください。'
      : code.includes('ai_draft_invalid') ? 'ページからの下書きを読み取れませんでした。'
      : code.includes('ai_draft_too_long') ? 'AIの下書きが長いため追加できません。下書きを整理してからお試しください。'
      : code.includes('session_workspace_not_empty') ? '前回のタブは、新しい空のタブだけの状態で復元できます。現在のタブを整理してからお試しください。'
      : code.includes('permission_expired') ? '権限の要求は終了しました。サイト側からもう一度操作してください。'
      : code.includes('download_file_missing') ? '保存したファイルが見つかりません。移動・削除された可能性があります。'
      : code.includes('download_not_resumable') ? 'このダウンロードは再開できません。サイトから新しくダウンロードしてください。'
      : code.includes('download_not_active') ? 'ダウンロードの状態が変わりました。一覧で現在の状態を確認してください。'
      : code.includes('download_unavailable') || code.includes('download_operation_failed') || code.includes('download_outcome_unknown') ? '操作結果を確認できません。一覧で現在の状態を確認してから操作してください。'
      : code.includes('download_history_unsupported') ? 'この環境ではプロフィールのダウンロード履歴を開けません。'
      : code.includes('download_history_busy') ? '進行中・一時停止中のダウンロードはHubの一覧で操作してください。'
      : code.includes('download_history_') ? '履歴画面を開けたか確認できません。現在のタブとブラウザの表示を確認してください。'
      : code.includes('browser_print_busy') ? '印刷ダイアログの表示を準備しています。状態を確認してから操作してください。'
      : code.includes('browser_print_') ? '印刷ダイアログを表示できたか確認できません。現在のタブと状態を確認してください。'
      : code.includes('browser_audio_') ? '音声の状態を変更できたか確認できません。タブの状態を確認してください。'
      : code.includes('browser_tab_context_changed') || code.includes('browser_tab_not_found') ? '操作元のタブが変わりました。現在のタブを確認してください。'
      : code.includes('browser_reader_close_unknown') ? '元のページへの復帰を確認できません。もう一度閉じてください。'
      : code.includes('browser_reader_') ? '本文を表示できませんでした。対応ページと現在のタブを確認してください。'
      : code.includes('tab_limit') ? 'タブは64個までです。不要なタブを閉じてください。'
      : '操作できませんでした。もう一度お試しください。';
    error.hidden = false;
  }
  async function run(command, args) { error.hidden = true; return invoke(command, args); }
  const validPrintToken = value => typeof value==='string'&&value.length>0&&value.length<=128&&!/[^\x21-\x7e]/.test(value);
  const controlSource = tab => ({id:tab.id,url:tab.url,activeId:active()?.id,activeUrl:active()?.url,epoch:browserControlEpoch,muted:tab.muted,contextToken:tab.printContextToken});
  const controlCurrent = source => isActive() && getView() === 'browser' && source.epoch === browserControlEpoch
    && active()?.id === source.activeId && active()?.url === source.activeUrl
    && tabs.some(tab => tab.id === source.id && tab.url === source.url && !tab.discarded);
  const controlAllowed = (source,kind) => !reader?.active && !reader?.busy && !controlsStale && controlCurrent(source) && !pendingSelect && !pendingNewTab && !selectionsInFlight
    && (kind === 'mute' ? !mutePending.has(source.id) && tabs.some(tab => tab.id === source.id && tab.canMute && typeof tab.muted === 'boolean' && tab.muted === source.muted)
      : !printPending && !printCheckPending && source.id === active()?.id && active()?.canPrint && validPrintToken(source.contextToken) && active()?.printContextToken===source.contextToken && Boolean(pageUrl(source.url)));
  const printCurrent = source => controlCurrent(source)&&active()?.printContextToken===source.contextToken;
  function syncBrowserControls() {
    if(findReader&&!reader?.searchReady){findReader=false;findBar.hidden=true;$('#browser-find-status').textContent='';}
    for (const node of [...menu.querySelectorAll('[data-browser-control]'), ...document.querySelectorAll('.sidebar-tab [data-browser-control]')]) node.disabled = !controlAllowed(node.browserSource,node.dataset.browserControl);
    for (const node of menu.querySelectorAll('[data-browser-reader]')) node.disabled=Boolean(reader?.busy||reader?.active||!readerReady());
  }
  function readerContext(){const tab=active();return isActive()&&getView()==='browser'&&pageUrl(tab?.url)?{id:tab.id,url:tab.url,epoch:browserControlEpoch}:null;}
  function readerReady(){return !controlsStale&&readerContext()&&!pendingSelect&&!pendingNewTab&&!selectionsInFlight&&!composing&&!tabComposing;}
  async function readerBeforeAction(){if(!reader.active&&!reader.busy)return true;const source=readerContext();if(await reader.close()===false)return false;const now=readerContext();return Boolean(source&&now&&source.id===now.id&&source.url===now.url&&source.epoch===now.epoch);}
  function browserControl(label,kind,tab) {
    const source=controlSource(tab), node=button(label,()=>kind==='mute'?setMuted(source):showPrint(source));
    node.dataset.browserControl=kind;node.dataset.browserTabId=String(tab.id);node.browserSource=source;
    node.disabled=!controlAllowed(source,kind);return node;
  }
  async function setMuted(source) {
    if(!controlAllowed(source,'mute'))return;
    mutePending.add(source.id);syncBrowserControls();
    try {
      await run('browser_set_muted',{id:source.id,muted:!source.muted});
      if(!controlCurrent(source))return;
      await refresh();
      if(controlCurrent(source)&&!menu.hidden)tabMenu(tabs.find(tab=>tab.id===source.id));
    } catch(reason) {
      if(controlCurrent(source)) {
        await refresh();
        if(controlCurrent(source)){if(!menu.hidden)tabMenu(tabs.find(tab=>tab.id===source.id));report(reason);}
      }
    }
    finally { mutePending.delete(source.id);syncBrowserControls(); }
  }
  async function showPrint(source=active()&&controlSource(active())) {
    if(!source||!controlAllowed(source,'print'))return;
    printCheckPending=true;syncBrowserControls();menu.hidden=true;
    try {
      await refresh();
      if(!printCurrent(source))return;
      printCheckPending=false;if(!controlAllowed(source,'print'))return;
      printPending=true;syncBrowserControls();
      const value=await run('browser_show_print',{id:source.id,contextToken:source.contextToken});
      if(!printCurrent(source))return;
      if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==2
        ||!Object.hasOwn(value,'tabId')||!Object.hasOwn(value,'dialogShown')||value.tabId!==source.id||value.dialogShown!==true)throw Error('browser_print_outcome_unknown');
      // Acknowledges the dialog only; printing and destination remain user choices.
      await refresh();
    } catch(reason) { if(printCurrent(source))report(reason); }
    finally { printPending=false;printCheckPending=false;syncBrowserControls(); }
  }
  async function requestPrint(payload) {
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Reflect.ownKeys(payload).length!==2
      ||!Object.hasOwn(payload,'tabId')||!Object.hasOwn(payload,'contextToken')||!Number.isSafeInteger(payload.tabId)||payload.tabId<=0
      ||!validPrintToken(payload.contextToken)||payload.contextToken!==active()?.printContextToken
      ||payload.tabId!==active()?.id||composing||tabComposing)return;
    await showPrint(controlSource(active()));
  }
  const panel = $('#sidebar-tabs'), narrow = window.matchMedia('(max-width: 720px)'), shell = $('.app-shell');
  let horizontalTabs = false, lastTabPosition = null;
  try { horizontalTabs = window.localStorage.getItem('hub.browser.tabLayout') === 'horizontal'; } catch { /* optional */ }
  const placeTabs = () => {
    shell.classList.toggle('browser-tabs-horizontal', horizontalTabs);
    if (horizontalTabs) $('#browser-tabbar').append(panel);
    else if (narrow.matches) $('#browser-mobile-tabs').append(panel);
    else $('.sidebar').insertBefore(panel, $('.account-nav'));
  };
  placeTabs(); narrow.addEventListener('change', placeTabs);
  const verticalTabs=createBrowserVerticalTabs({document,window,shell,panel,pin:$('#browser-tabs-pin'),menu,isCurrent:()=>isActive()&&getView()==='browser',isBlocked:()=>dragging!==null});
  const hideSuggestions = () => { suggestions.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); suggestionIndex = -1; };
  function selectSuggestion(index) {
    suggestionIndex = index;
    [...suggestions.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', `browser-suggestion-${index}`);
      suggestions.children[index]?.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    else input.removeAttribute('aria-activedescendant');
  }
  const panels = initBrowserPanels({ document, window, invoke, button, report, refresh, hideSuggestions,
    getActiveTab:()=>!controlsStale&&isActive()&&getView()==='browser'?{...active(),epoch:browserControlEpoch}:null,
    getView:()=>isActive()?getView():null,
    beforePanelOpen:()=>{protection.close();bookmarkBar?.close();return reader?.active||reader?.busy?reader.close():true;},
    beforeDownloadHistory:async current=>{
      cancelPendingMenu();privacyPanel=null;hideSuggestions();menu.hidden=true;findBar.hidden=true;
      await new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)));
      return current();
    } });
  reader=initBrowserReader({document,host:$('#browser-reader'),invoke:run,getContext:readerContext,canOpen:readerReady,
    refresh:async()=>{await refresh();if(controlsStale||settledGeneration!==generation||renderedGeneration!==generation)throw Error('browser_reader_unavailable');},report,onStateChange:syncBrowserControls,
    beforeOpen:()=>{protection.close();bookmarkBar?.close();panels.closeMode();privacyPanel=null;hideSuggestions();menu.hidden=true;findBar.hidden=true;}});
  const bookmarkBarHost = $('#browser-bookmark-bar');
  const bookmarkBar = bookmarkBarHost ? createBrowserBookmarkBar({document,window,host:bookmarkBarHost,report,
    isCurrent:()=>isActive()&&getView()==='browser',open:(entry,destination)=>choose(entry,destination,active()?.id??null),manage:()=>showMenu('favorites')}) : null;
  const protection=createBrowserProtection({document,invoke,isCurrent:()=>isActive()&&getView()==='browser',
    beforeOpen:async()=>{
      cancelPendingMenu();panels.closeMode();privacyPanel=null;bookmarkBar?.close();hideSuggestions();menu.hidden=true;findBar.hidden=true;
      if(!await readerBeforeAction()||!isActive()||getView()!=='browser')return false;
      await invoke('browser_focus_controls');return isActive()&&getView()==='browser';
    },onError:({code})=>report(code)});
  $('#browser-navigation').append(protection.button);$('#browser-menu').after(protection.element);
  $('#browser-scheme').onclick = () => { if (!menu.hidden && menuKind === 'site') { menu.hidden = true; return; } showMenu('site'); };
  const autoplay=createBrowserAutoplay({document,invoke,getUrl:()=>active()?.private?null:active()?.url??null,onError:({code})=>report(code)});
  protection.element.append(autoplay.element);
  protection.button.addEventListener('click',()=>void autoplay.load());
  bookmarkBarHost?.addEventListener('click',()=>protection.close());
  async function choose(entry, destination = 'current', addressTab = null) {
    if (entry?.kind === 'hub') { hideSuggestions(); input.blur(); await onHubSearch?.(entry.query); return; }
    const addressCurrent = () => addressTab === null || isActive() && getView() === 'browser' && active()?.id === addressTab;
    if(!addressCurrent())throw Error('browser_tab_context_changed');
    if((reader.active||reader.busy)&&!await readerBeforeAction())return;
    if(!addressCurrent())throw Error('browser_tab_context_changed');
    cancelPendingFocus();
    const focus = focusGeneration, menuTurn = menuGeneration, epoch = browserControlEpoch, tabIdentity = activeTabIdentity;
    ++selectionsInFlight;
    try {
      if (destination !== 'background') { panels.closeMode(); hideSuggestions(); menu.hidden = true; }
      if (destination !== 'current') await run('browser_open_tab', { url: entry.url, foreground: destination === 'foreground' });
      else if (entry.kind === 'tab') await run('browser_activate_tab', { id: entry.id });
      else await run(addressTab === null ? 'browser_navigate' : 'browser_navigate_from_address', addressTab === null ? { url: entry.url } : { id: addressTab, url: entry.url });
      if (destination !== 'background' && tabIdentity === activeTabIdentity && focus === focusGeneration && menuTurn === menuGeneration && isActive() && getView() === 'browser') input.blur();
    } catch(reason) {
      if(addressTab !== null && (focus !== focusGeneration || menuTurn !== menuGeneration || epoch !== browserControlEpoch || !addressCurrent()))return;
      throw reason;
    } finally { --selectionsInFlight; }
  }
  function bindPageLink(node, entry, live = () => node.isConnected && !node.closest('[hidden]'), addressTab = null) {
    const open = event => {
      if (!live() || node.disabled || getView() !== 'browser' || !isActive()) return;
      if (event?.type === 'auxclick' && event.button !== 1 || event?.altKey) return;
      const separate = event?.button === 1 || event?.ctrlKey || event?.metaKey || event?.shiftKey;
      event?.preventDefault();
      void choose(entry, separate ? event?.shiftKey ? 'foreground' : 'background' : 'current', addressTab).catch(report);
    };
    node.onclick = open; node.onauxclick = open;
    node.onmousedown = event => { if (event.button === 1) event.preventDefault(); };
  }
  function showSuggestions() {
    if(reader?.active||reader?.busy)void reader.close();
    const addressTab = addressDraftTab;
    candidates = addressSuggestions(input.value, { tabs, favorites, history, engine });
    // 一番上の欄はHubの検索も兼ねる。言葉を入れたら「Hubで検索」を2番目に足す（確定するまで送らない）。
    const hubQuery = input.value.trim();
    if (hubQuery && typeof onHubSearch === 'function') candidates.splice(Math.min(1, candidates.length), 0, { kind: 'hub', query: hubQuery, title: `Hubで「${hubQuery}」を検索`, detail: 'Hub内の検索' });
    candidates = candidates.slice(0, 8);
    suggestions.replaceChildren();
    candidates.forEach((entry, i) => {
      const node = button('', () => choose(entry, 'current', addressTab), 'browser-suggestion'); node.id = `browser-suggestion-${i}`; node.setAttribute('role', 'option'); node.setAttribute('aria-selected', 'false');
      const title = document.createElement('strong'); title.textContent = entry.title;
      const detail = document.createElement('small'); detail.textContent = entry.detail || `${({ tab: '開いているタブへ', favorite: 'お気に入り', history: '履歴', navigate: '開く' })[entry.kind]} · ${entry.url}`;
      node.append(title, detail); bindPageLink(node, entry, () => node.isConnected && !node.closest('[hidden]') && addressTab === active()?.id && isActive() && getView() === 'browser', addressTab); node.onmousedown = event => { if (event.button === 0 || event.button === 1) event.preventDefault(); }; suggestions.append(node);
    });
    suggestionIndex = -1; suggestions.hidden = !candidates.length; input.setAttribute('aria-expanded', String(candidates.length > 0)); input.removeAttribute('aria-activedescendant');
    menu.hidden = true;
  }
  const hasHubHistory = () => typeof getHubHistory==='function'&&typeof onHubHistory==='function';
  function hubHistory(action){
    if(!hasHubHistory())return null;
    try{const value=getHubHistory()?.[action];return value?.available===true&&typeof value.label==='string'?value:null;}catch{return null;}
  }
  function syncNavigation(){
    const tab=active();
    for(const [action,capability,label] of [['back','canBack','ページに戻る'],['forward','canForward','ページを進む']]){
      const page=tab?.[capability]===true,hub=page?null:hubHistory(action),button=$('#browser-'+action);
      button.disabled=!page&&!hub;button.title=hub?(hub.label||label):label;button.setAttribute('aria-label',button.title);
    }
  }
  async function navigateHistory(action){
    if(!isActive()||getView()!=='browser'||composing||tabComposing)return;
    const id=active()?.id,url=active()?.url,identity=activeTabIdentity,epoch=browserControlEpoch,focus=focusGeneration,menuTurn=menuGeneration;
    const current=()=>isActive()&&getView()==='browser'&&active()?.id===id&&active()?.url===url&&activeTabIdentity===identity&&browserControlEpoch===epoch&&focusGeneration===focus&&menuGeneration===menuTurn&&!composing&&!tabComposing;
    if((reader.active||reader.busy)&&!await readerBeforeAction())return;
    if(!current())return;
    const page=active()?.[action==='back'?'canBack':'canForward']===true;
    const hub=page?null:hubHistory(action);
    if(hasHubHistory()&&!page&&!hub)return;
    cancelPendingFocus();
    if(page||!hasHubHistory())await run('browser_'+action);
    else await onHubHistory(action==='back'?-1:1);
  }
  function displayActive() {
    const tab = active();
    if (document.activeElement !== input && !(nativeChrome && nativeDraftTab === tab?.id)) { input.value = tab?.url ?? ''; addressDraftTab = tab?.id ?? null; }
    syncNavigation();
    const localGames = $('#browser-local-games');
    if (localGames) localGames.hidden = !isHubGamesUrl(tab?.url);
    for (const id of ['browser-fav', 'browser-ai', 'browser-find']) $(`#${id}`).disabled = !tab?.url;
    $('#browser-reload').disabled = !tab?.url;
    $('#browser-reload').innerHTML = icon(tab?.loading ? 'x' : 'refresh');
    $('#browser-reload').title = tab?.loading ? '読み込みを停止' : '再読み込み';
    $('#browser-reload').setAttribute('aria-label', $('#browser-reload').title);
    const secure = pageUrl(tab?.url)?.protocol === 'https:';
    // サイトの情報の押し手（押すとサイトの情報）。保護された通信は鍵、保護されていない通信は注意の三角、ページが無いときは調整の記号。
    const schemeState = !tab?.url ? 'none' : secure ? 'secure' : pageUrl(tab.url) ? 'insecure' : 'none';
    const schemeGlyph = { secure: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', insecure: '<path d="M12 4.2 21 19.5H3z"/><path d="M12 10v4.4M12 17.1v.01"/>', none: '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/>' }[schemeState];
    $('#browser-scheme').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${schemeGlyph}</svg>`;
    $('#browser-scheme').dataset.state = schemeState;
    $('#browser-scheme').classList.toggle('is-plain', schemeState !== 'secure');
    $('#browser-scheme').title = tab?.url ? secure ? 'サイトの情報（保護された通信）' : 'サイトの情報（保護されていない通信）' : 'サイトの情報';
    $('#browser-scheme').setAttribute('aria-label', $('#browser-scheme').title);
    const saved = favorites.some(entry => entry.url === tab?.url);
    $('#browser-fav').innerHTML = icon('star', saved); $('#browser-fav').classList.toggle('is-on', saved);
    $('#browser-fav').title = saved ? 'お気に入りから削除' : 'お気に入りに追加'; $('#browser-fav').setAttribute('aria-label', $('#browser-fav').title);
    $('#browser-zoom').textContent = `${Math.round((tab?.zoom ?? 1) * 100)}%`;
  }
  // 表示中・休止済み・プライベートのタブは休ませない（Rust側でも同じ条件で拒む）。
  // ほかのタブをまとめて休ませる。音を出しているタブは残す。
  function sleepOthers() {
    const count = tabs.filter(tab => canSleepTab(tab) && tab.playingAudio !== true).length;
    const node = button(count ? `ほかの${count}タブを休止してメモリを空ける` : '休ませられるタブはありません', async () => { await run('browser_sleep_background_tabs', {}); menu.hidden = true; await refresh(); });
    node.dataset.browserSleepOthers = String(count); node.disabled = count === 0; return node;
  }
  function canSleepTab(tab) { return !tab.discarded && !tab.private && !(tab.active && isActive() && getView() === 'browser'); }
  function tabMenu(tab) {
    protection.close();bookmarkBar?.close();
    if(reader?.active||reader?.busy){void reader.close().then(ok=>{if(ok!==false)tabMenu(tab);});return;}
    cancelPendingMenu();
    hideSuggestions(); menu.replaceChildren(); menu.hidden = false;
    const heading = document.createElement('p'); heading.className = 'browser-menu-empty'; heading.textContent = tab.title || pageUrl(tab.url)?.hostname || '新しいタブ'; menu.append(heading);
    const action = (label, command, args, disabled = false) => { const item = button(label, async () => { await run(command, args); menu.hidden = true; await refresh(); }); item.disabled = disabled; menu.append(item); };
    // 再読み込みは表示中のタブだけ（裏のタブを読み直す命令は無い）。
    if (tab.active && !tab.discarded) action('再読み込み', 'browser_reload', {});
    action(tab.pinned ? '固定を解除' : 'タブを固定', 'browser_pin_tab', { id: tab.id, pinned: !tab.pinned });
    action('複製', 'browser_duplicate_tab', { id: tab.id });
    action(tab.discarded ? '休止中（選ぶと再開）' : 'このタブを休止', 'browser_sleep_tab', { id: tab.id }, !canSleepTab(tab));
    menu.append(browserControl(tab.muted===true?'音声のミュートを解除':tab.muted===false?'音声をミュート':'音声の状態を確認できません','mute',tab));
    menu.append(button('グループを変更', () => groupForm(tab)));
    const index = tabs.indexOf(tab);
    action('前へ移動', 'browser_move_tab', { id: tab.id, position: Math.max(0, index - 1) }, index <= 0 || Boolean(tabs[index - 1]?.pinned) !== Boolean(tab.pinned));
    action('後ろへ移動', 'browser_move_tab', { id: tab.id, position: Math.min(tabs.length - 1, index + 1) }, index >= tabs.length - 1 || Boolean(tabs[index + 1]?.pinned) !== Boolean(tab.pinned));
    if (!tab.pinned) action('閉じる', 'browser_close_tab', { id: tab.id });
    // 固定したタブは閉じない（Rust側でも除外する）。
    if (tabs.some(other => other.id !== tab.id && !other.pinned)) action('他のタブを閉じる', 'browser_close_other_tabs', { id: tab.id });
    if (tabs.slice(tabs.findIndex(other => other.id === tab.id) + 1).some(other => !other.pinned)) action('右側のタブを閉じる', 'browser_close_tabs_to_right', { id: tab.id });
    menu.append(button('閉じたタブを開く', async () => { menu.hidden = true; await restore(); }));
  }
  function groupForm(tab) {
    cancelPendingMenu(); menu.replaceChildren(); menu.hidden = false;
    const form = document.createElement('form'); form.className = 'browser-tab-group-form';
    const label = document.createElement('label'); label.textContent = 'グループ名';
    const name = document.createElement('input'); name.className = 'browser-menu-filter'; name.type = 'text'; name.maxLength = 80; name.value = tab.group || ''; name.setAttribute('aria-label', 'グループ名'); label.append(name);
    let editing = false; name.addEventListener('compositionstart', () => { editing = true; }); name.addEventListener('compositionend', () => { editing = false; });
    const message = document.createElement('p'); message.className = 'browser-menu-empty'; message.setAttribute('role', 'status'); message.hidden = true;
    const assign = async group => { if (!tabs.some(current => current.id === tab.id)) { menu.hidden = true; return; } await run('browser_set_tab_group', { id: tab.id, group }); menu.hidden = true; await refresh(); };
    const save = button('保存', () => {}); save.type = 'submit';
    form.onsubmit = event => {
      event.preventDefault(); if (editing || event.isComposing || event.keyCode === 229) return;
      const group = name.value.trim();
      if (Array.from(group).length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(name.value)) { message.textContent = 'グループ名は制御文字を含まない80文字以内で入力してください。'; message.hidden = false; name.focus(); return; }
      void assign(group || null).catch(report);
    };
    form.append(label, message, save, button('グループを解除', () => assign(null)), button('キャンセル', () => tabMenu(tabs.find(current => current.id === tab.id) || tab))); menu.append(form); name.focus(); name.select();
  }
  async function chooseTab(id, selection = null) {
    cancelPendingFocus(selection); ++selectionsInFlight;
    const focus=focusGeneration;
    const scopeCurrent=()=>focus===focusGeneration&&isActive()&&getView()==='browser';
    const current=()=>scopeCurrent()&&!composing&&!tabComposing&&(!selection||pendingSelect===selection&&window.Date.now()<selection.expiresAt);
    try {
      if(reader.active||reader.busy){if(!await readerBeforeAction()){completeSelect(selection,'failed');return;}}
      if (!Number.isSafeInteger(id)||id<=0) { completeSelect(selection, 'failed'); return; }
      if (!isActive()) await enterBrowser();
      if (!current()) { completeSelect(selection, 'failed'); return; }
      // Native creation can precede the inventory-change event reaching this UI.
      // Validate the exact ID against a fresh read, never an old rendered list.
      const finishFetch=metrics.begin('browserFetch');let results;
      try {results=await (probeProfile===1?readWorkspace():readWorkspaceLegacy());}finally{finishFetch();}
      if (!current()) { completeSelect(selection, 'failed'); return; }
      if (results[0].status!=='fulfilled') {
        completeSelect(selection,'failed');
        report(results[0].reason);
        return;
      }
      if (!filterBrowserTabs(results[0].value).some(tab=>tab.id===id)) {completeSelect(selection,'failed');return;}
      await run('browser_activate_tab', { id });
      if (!current()) { completeSelect(selection, 'failed'); return; }
      if (selection) selection.activated = true;
      hideSuggestions(); menu.hidden = true;
      await refresh();
      if (!current()) { completeSelect(selection, 'failed'); return; }
      acknowledgeSelect();
    } catch (reason) { const visible=scopeCurrent();completeSelect(selection, 'failed');if(visible)throw reason; } finally { --selectionsInFlight; }
  }
  function updateTabQuery(value) {
    tabQuery = value; tabIndex = 0;
    if (tabInput) tabInput.value = tabQuery;
    const popup = $('#browser-tab-menu-query'); if (popup) popup.value = tabQuery;
    renderTabs(); renderTabResults();
  }
  function tabQueryKey(event, popup = false) {
    if (event.defaultPrevented || tabComposing || event.isComposing || event.keyCode === 229 || popup && (menu.hidden || getView() !== 'browser')) return;
    const visible = filterBrowserTabs(tabs, tabQuery);
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      const tab = visible[popup ? tabIndex : 0];
      if (tab) void chooseTab(tab.id).catch(report);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (tabQuery) updateTabQuery('');
      else { menu.hidden = true; if (popup) $('#browser-tab-search')?.focus(); else tabInput?.blur(); }
    } else if (popup && visible.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      tabIndex = (tabIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
      renderTabResults();
      $(`#browser-tab-result-${visible[tabIndex].id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  function bindTabQuery(node, popup = false) {
    node.oninput = () => { cancelPendingMenu(); updateTabQuery(node.value); };
    node.addEventListener('compositionstart', () => { completeSelect(pendingSelect, 'failed'); completeRefresh(pendingRefresh, 'failed'); cancelPendingMenu(); tabComposing = true; });
    node.addEventListener('compositionend', () => { tabComposing = false; });
    node.onkeydown = event => tabQueryKey(event, popup);
  }
  function renderTabs() {
    const list = $('#sidebar-tabs-list'), focused = list.contains(document.activeElement) ? {id:document.activeElement.closest('[data-tab-id]')?.dataset.tabId,action:document.activeElement.dataset.tabAction,group:document.activeElement.dataset.tabGroup,pinned:document.activeElement.dataset.groupPinned} : null;
    list.replaceChildren();
    const visible = filterBrowserTabs(tabs, horizontalTabs ? '' : tabQuery);
    if ($('#sidebar-tab-count')) { const sleeping = tabs.filter(tab => tab.discarded).length; $('#sidebar-tab-count').textContent = `${visible.length} / ${tabs.length} タブ${sleeping ? ` · 休止中 ${sleeping}` : ''}`; }
    if ($('#sidebar-tab-empty')) { $('#sidebar-tab-empty').hidden = visible.length > 0; $('#sidebar-tab-empty').textContent = tabs.length ? '一致するタブはありません' : '開いているタブはありません'; }
    const sections = [], groups = new Map();
    for (const tab of visible) {
      if (horizontalTabs || !tab.group) { sections.push({ tabs: [tab] }); continue; }
      const key = JSON.stringify([Boolean(tab.pinned), tab.group]);
      if (!groups.has(key)) { const section = { group: tab.group, pinned: Boolean(tab.pinned), tabs: [] }; groups.set(key, section); sections.push(section); }
      groups.get(key).tabs.push(tab);
    }
    for (const section of sections) {
      if (section.group) {
        const keepOpen = tabs.some(tab => tab.group === section.group && Boolean(tab.pinned) === section.pinned && (tab.active || tab.private));
        const collapsed = !tabQuery && !keepOpen && collapsedGroups.has(section.group);
        const heading = button(`${collapsed ? '▸' : '▾'} ${section.group} · ${section.tabs.length}`, () => {
          if (collapsedGroups.has(section.group)) collapsedGroups.delete(section.group); else collapsedGroups.add(section.group);
          try { window.localStorage.setItem('hub.browser.collapsedGroups', JSON.stringify([...collapsedGroups])); } catch { /* optional preference */ }
          renderTabs();
        }, 'browser-menu-tab browser-tab-group');
        heading.dataset.tabGroup = section.group; heading.dataset.groupPinned = String(section.pinned); heading.setAttribute('aria-expanded', String(!collapsed)); heading.disabled = keepOpen || Boolean(tabQuery); heading.title = keepOpen ? '選択中・プライベートのタブを含むグループは表示を保ちます' : tabQuery ? '検索中はグループを表示します' : collapsed ? 'グループを開く' : 'グループを折りたたむ'; list.append(heading);
        if (collapsed) continue;
      }
      for (const tab of section.tabs) {
      const host = pageUrl(tab.url)?.hostname || '', title = tab.title || host || '新しいタブ';
      const row = document.createElement('div'); row.className = `sidebar-tab${tab.active && isActive() ? ' is-active' : ''}${tab.discarded ? ' is-discarded' : ''}`; row.draggable = true; row.dataset.tabId = String(tab.id); row.id = `browser-tab-${tab.id}`;
      row.onmousedown = event => { if (event.button === 1) event.preventDefault(); };
      row.onauxclick = event => { if (event.button === 1) { event.preventDefault(); if (row.isConnected && isActive() && getView() === 'browser') void closeTab(tab.id).catch(report); } };
      row.ondragstart = event => { dragging = tab.id; event.dataTransfer.setData('text/plain', String(tab.id)); };
      row.ondragend = () => { dragging = null; };
      row.ondragover = event => { if (dragging !== null) event.preventDefault(); };
      row.ondrop = event => { event.preventDefault(); const source = tabs.find(current => current.id === dragging), target = tabs.find(current => current.id === tab.id); if (source && target && source.id !== target.id && Boolean(source.pinned) === Boolean(target.pinned)) void run('browser_move_tab', { id: source.id, position: tabs.indexOf(target) }).then(refresh).catch(report); dragging = null; };
      const select = button('', () => chooseTab(tab.id), 'browser-tab-select');
      select.dataset.tabAction = 'select';
      select.onkeydown = event => { if (!event.isComposing && event.keyCode !== 229 && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) { event.preventDefault(); tabMenu(tab); } };
      select.title = `${tab.private ? 'プライベート · ' : ''}${title} · ${tab.url || '新しいタブ'}${tab.discarded ? ' · 休止中（メモリを空けています）。選ぶとすぐ再開' : ''}`; select.setAttribute('aria-label', `${tab.private ? 'プライベート · ' : ''}${tab.discarded ? '休止中 · ' : ''}${title} · ${tab.url || '新しいタブ'}`); if (tab.active && isActive()) select.setAttribute('aria-current', 'page');
      const badge = document.createElement('span'); badge.className = 'browser-tab-badge'; badge.textContent = tab.private ? '◇' : tab.loading ? '…' : (host.replace(/^www./, '') || '新')[0].toUpperCase(); const icon = tab.private ? null : faviconImage(document, tab.favicon); if (icon) badge.replaceChildren(icon); if (tab.private) badge.title = 'プライベート';
      const text = document.createElement('span'); text.className = 'browser-tab-text'; const name = document.createElement('span'); name.className = 'browser-tab-title'; name.textContent = `${tab.pinned ? '◆ ' : ''}${title}`;
      // 音のアイコンは押すとミュートを切り替える（Chrome/Edgeと同じ）。切り替えられないときは表示だけ。
      let audio=null,audioToggle=null;if(tab.muted===true||tab.playingAudio===true){audio=document.createElement('span');audio.className='browser-tab-badge';audio.textContent=tab.muted===true?'🔇':'♪';audio.setAttribute('role','img');audio.setAttribute('aria-label',tab.muted===true?'音声ミュート中':'音声再生中');audio.title=audio.getAttribute('aria-label');const toggle=browserControl('','mute',tab);if(tab.canMute===true&&typeof tab.muted==='boolean'&&!tab.discarded){toggle.className='browser-tab-audio';toggle.dataset.tabAction='audio';toggle.setAttribute('aria-label',`${title}の${tab.muted===true?'ミュートを解除':'音声をミュート'}`);toggle.title=tab.muted===true?'クリックでミュートを解除':'クリックでミュート';toggle.append(audio);audio=null;audioToggle=toggle;}}
      const sub = document.createElement('small'); sub.className = 'browser-tab-path'; sub.textContent = `${tab.private ? 'プライベート · ' : ''}${tab.url || '新しいタブ'}`; if (tab.discarded) { const sleeping = document.createElement('span'); sleeping.className = 'browser-tab-sleeping'; sleeping.textContent = '休止中'; sub.prepend(sleeping, ' · '); } text.append(name, sub); select.append(badge, text);
      if(audio)select.append(audio);
      const options = button('⋯', () => tabMenu(tab), 'browser-tab-close browser-tab-options'); options.dataset.tabAction = 'options'; options.title = 'タブの操作（右クリックでも開けます）'; options.setAttribute('aria-label', `${title}の操作`);
      row.oncontextmenu = event => { event.preventDefault(); tabMenu(tab); }; row.append(select); if (audioToggle) row.append(audioToggle); row.append(options);
      if (!tab.pinned) { const close = button('×', () => closeTab(tab.id), 'browser-tab-close'); close.dataset.tabAction = 'close'; close.setAttribute('aria-label', `${title}を閉じる`); row.append(close); }
      $('#sidebar-tabs-list').append(row);
      }
    }
    if (focused && isActive() && getView() === 'browser') {
      const row = [...list.children].find(row => focused.group !== undefined ? row.dataset.tabGroup === focused.group && row.dataset.groupPinned === focused.pinned : row.dataset.tabId === focused.id);
      (focused.group !== undefined && row && !row.disabled ? row : row?.querySelector(`[data-tab-action="${focused.action}"]`) || list.querySelector('.is-active .browser-tab-select'))?.focus({preventScroll:true});
    }
    const selected = active(), position = selected && isActive() && getView() === 'browser' ? `${selected.id}:${visible.indexOf(selected)}:${horizontalTabs}` : null;
    if (position && position !== lastTabPosition) {
      const row = [...list.children].find(row => row.dataset.tabId === String(selected.id));
      if (row && (horizontalTabs ? row.offsetLeft < list.scrollLeft || row.offsetLeft + row.offsetWidth > list.scrollLeft + list.clientWidth : row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)) row.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    lastTabPosition = position;
    displayActive();
  }
  async function closeTab(id) {
    if((reader.active||reader.busy)&&!await readerBeforeAction())return;
    const tab = tabs.find(tab => tab.id === id);
    if (!tab || tab.pinned) return;
    await run('browser_close_tab', {id}); await refresh();
  }
  function cancelPendingMenu() { ++menuGeneration; }
  function cancelPendingFocus(selection = null) { ++findRevision;void reader?.invalidate();++browserControlEpoch;syncBrowserControls();pendingNativeAddress = null; completeRefresh(pendingRefresh, 'superseded'); if (pendingSelect !== selection) completeSelect(pendingSelect, 'superseded'); cancelPendingMenu(); ++focusGeneration; pendingNewTab = null; }
  function completeSelect(selection, outcome) {
    if (!selection || pendingSelect !== selection) return;
    pendingSelect = null; window.clearTimeout(selection.timer);
    try { void Promise.resolve(invoke('browser_control_select_ack', { requestId: selection.requestId, tabId: selection.tabId, outcome })).catch(report); } catch (reason) { report(reason); }
  }
  function acknowledgeSelect() {
    const selection = pendingSelect;
    if (!selection) return;
    if (window.Date.now() >= selection.expiresAt || !isActive() || getView() !== 'browser' || composing || tabComposing) { completeSelect(selection, 'failed'); return; }
    if (!selection.activated || settledGeneration !== generation || renderedGeneration !== generation) return;
    completeSelect(selection, active()?.id === selection.tabId ? 'applied' : 'failed');
  }
  function controlSelect(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 3 || !['requestId', 'tabId', 'expiresAt'].every(key => Object.hasOwn(payload, key) && Number.isSafeInteger(payload[key]) && payload[key] > 0) || payload.requestId <= lastSelectRequest) return;
    lastSelectRequest = payload.requestId; completeSelect(pendingSelect, 'superseded');
    const selection = { ...payload, activated: false, timer: null }; pendingSelect = selection;
    selection.timer = window.setTimeout(() => completeSelect(selection, 'failed'), Math.min(10_000, Math.max(0, selection.expiresAt - window.Date.now())));
    if (window.Date.now() >= selection.expiresAt || getView() !== 'browser' || !isActive() || composing || tabComposing) { completeSelect(selection, 'failed'); return; }
    void chooseTab(selection.tabId, selection).catch(report);
  }
  async function focusNewTab() {
    const pending = pendingNewTab, tab = active();
    if (pending && window.Date.now() >= pending.expiresAt) { cancelPendingFocus(); return; }
    if (pending && pending.observed !== null && tabs.find(tab => tab.id === pending.observed)?.url !== '') { cancelPendingFocus(); return; }
    if (!pending?.ack || pending.focusing || pending.observed !== tab?.id || tab?.url !== '' || !isActive() || getView() !== 'browser') return;
    pending.focusing = true; pending.returnFocus = document.activeElement; updateTabQuery('');
    try { await invoke(nativeChrome ? 'browser_focus_address' : 'browser_focus_controls'); } catch (reason) { if (pendingNewTab === pending) cancelPendingFocus(); throw reason; }
    if (window.Date.now() >= pending.expiresAt || pendingNewTab !== pending || pending.turn !== focusGeneration || !isActive() || getView() !== 'browser' || active()?.id !== tab.id || active()?.url !== '') { if (pendingNewTab === pending) cancelPendingFocus(); return; }
    pendingNewTab = null; hideSuggestions(); menu.hidden = true; input.value = ''; if (nativeChrome) { $('#browser-navigation').classList.add('native-backed'); return; } input.focus(); input.select();
  }
  function setProbeProfile(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 3 || !Object.hasOwn(payload, 'expiresAt') || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= 0 || !Object.hasOwn(payload, 'requestId') || !Number.isSafeInteger(payload.requestId) || payload.requestId <= probeRequest || !Object.hasOwn(payload, 'profile') || payload.profile !== 0 && payload.profile !== 1) return;
    probeRequest = payload.requestId;
    const accepted = !pendingRefresh && !pendingSelect && !pendingNewTab && selectionsInFlight === 0 && refreshesInFlight === 0 && renderedGeneration === generation && settledGeneration === generation && !composing && !tabComposing && isActive() && getView() === 'browser' && fallbackCount < Number.MAX_SAFE_INTEGER && window.Date.now() < payload.expiresAt;
    if (accepted) probeProfile = payload.profile;
    try { void Promise.resolve(invoke('browser_probe_profile_ack', { requestId: payload.requestId, profile: payload.profile, accepted, fallbackCount })).catch(report); } catch (reason) { report(reason); }
  }
  function completeRefresh(request, outcome) {
    if (!request || pendingRefresh !== request) return;
    pendingRefresh = null; window.clearTimeout(request.timer);
    try { void Promise.resolve(invoke('browser_control_refresh_ack', { requestId: request.requestId, tabId: request.tabId, profile: request.profile, outcome })).catch(report); } catch (reason) { report(reason); }
  }
  function acknowledgeRefresh() {
    const request = pendingRefresh;
    if (!request) return;
    if (request.turn !== generation) { completeRefresh(request, 'superseded'); return; }
    if (window.Date.now() >= request.expiresAt || !isActive() || getView() !== 'browser' || composing || tabComposing || pendingSelect || pendingNewTab || selectionsInFlight || probeProfile !== request.profile || active()?.id !== request.tabId) { completeRefresh(request, 'failed'); return; }
    if (request.readsFulfilled && renderedGeneration === request.turn && settledGeneration === request.turn) completeRefresh(request, 'applied');
  }
  function controlRefresh(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 4 || !['requestId', 'tabId', 'expiresAt'].every(key => Object.hasOwn(payload, key) && Number.isSafeInteger(payload[key]) && payload[key] > 0) || !Object.hasOwn(payload, 'profile') || payload.profile !== 0 && payload.profile !== 1 || payload.requestId <= lastRefreshRequest) return;
    lastRefreshRequest = payload.requestId; completeRefresh(pendingRefresh, 'superseded');
    const request = { ...payload, turn: generation + 1, readsFulfilled: false, timer: null }; pendingRefresh = request;
    request.timer = window.setTimeout(() => completeRefresh(request, 'failed'), Math.min(10_000, Math.max(0, request.expiresAt - window.Date.now())));
    if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER || pendingSelect || pendingNewTab || selectionsInFlight || refreshesInFlight || renderedGeneration !== generation || settledGeneration !== generation || composing || tabComposing || !isActive() || getView() !== 'browser' || active()?.id !== request.tabId || probeProfile !== request.profile || window.Date.now() >= request.expiresAt) { completeRefresh(request, 'failed'); return; }
    void refresh().catch(reason => { completeRefresh(request, 'failed'); report(reason); });
  }
  function readWorkspaceLegacy() { return Promise.allSettled([invoke('browser_tabs'), invoke('browser_favorites'), invoke('browser_history')]); }
  async function readWorkspace() {
    try {
      const snapshot = await invoke('browser_workspace_snapshot');
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Reflect.ownKeys(snapshot).length !== 4 || !['version', 'tabs', 'favorites', 'history'].every(key => Object.hasOwn(snapshot, key)) || snapshot.version !== 1 || !['tabs', 'favorites', 'history'].every(key => Array.isArray(snapshot[key]))) throw Error('invalid_workspace_snapshot');
      return [snapshot.tabs, snapshot.favorites, snapshot.history].map(value => ({ status: 'fulfilled', value }));
    } catch { fallbackCount = Math.min(Number.MAX_SAFE_INTEGER, fallbackCount + 1); return Promise.allSettled([invoke('browser_tabs'), invoke('browser_favorites'), invoke('browser_history')]); }
  }
  async function refresh(tabChanged = false) {
    const finishRefresh = metrics.begin('browserRefresh'); let turn;
    const readWorkspaceSelected = probeProfile === 1 ? readWorkspace : readWorkspaceLegacy; ++refreshesInFlight;
    try {
      if (tabChanged === true && pendingNewTab) pendingNewTab.tabChanged = true;
      turn = ++generation;
      controlsStale=true;syncBrowserControls();
      if (pendingRefresh && pendingRefresh.turn !== turn) completeRefresh(pendingRefresh, 'superseded');
      const finishFetch = metrics.begin('browserFetch'); let results;
      try { results = await readWorkspaceSelected(); } finally { finishFetch(); }
      if (turn !== generation) return;
      if (results[0].status !== 'fulfilled') completeSelect(pendingSelect, 'failed');
      if (results.some(result => result.status !== 'fulfilled')) completeRefresh(pendingRefresh, 'failed');
      else if (pendingRefresh?.turn === turn) pendingRefresh.readsFulfilled = true;
      if (results[0].status === 'rejected') { report(results[0].reason); return; }
      if (results[1].status === 'rejected') report(results[1].reason);
      const finishRender = metrics.begin('browserRender');
      try {
        const signature=value=>JSON.stringify(value.map(tab=>[tab.id,tab.url,tab.active,tab.discarded,tab.private]));
        const nextTabs = filterBrowserTabs(results[0].value).map(tab => ({ ...tab, group: typeof tab.group === 'string' && tab.group.trim() ? tab.group : null, private: tab.private === true,
          muted:typeof tab.muted==='boolean'?tab.muted:null,playingAudio:typeof tab.playingAudio==='boolean'?tab.playingAudio:null,
          canMute:tab.canMute===true&&!tab.discarded&&typeof tab.muted==='boolean',
          printContextToken:validPrintToken(tab.printContextToken)?tab.printContextToken:null,
          canPrint:tab.canPrint===true&&!tab.discarded&&validPrintToken(tab.printContextToken) }));
        if(nextTabs.find(tab=>tab.active)?.id !== active()?.id)activeTabIdentity = {};
        if(signature(nextTabs)!==signature(tabs))++browserControlEpoch;
        tabs=nextTabs;controlsStale=false;reader.update();syncBrowserControls();
        if (results[1].status === 'fulfilled') { favorites = results[1].value; bookmarkBar?.update(favorites); }
        if (results[2].status === 'fulfilled') history = results[2].value;
        renderTabs(); renderTabResults(true); panels.updateTabs(tabs); privacyPanel?.update(); void protection.load(); renderedGeneration = turn;
      } finally { finishRender(); }
      if (pendingNewTab && window.Date.now() >= pendingNewTab.expiresAt) cancelPendingFocus();
      if (pendingNewTab && (!isActive() || getView() !== 'browser') && pendingNewTab.ack) cancelPendingFocus();
      if (pendingNewTab?.tabChanged) {
        const tab = active();
        if (tab && tab.url === '' && !pendingNewTab.before.has(tab.id)) pendingNewTab.observed = tab.id;
        await focusNewTab();
      }
    } catch (reason) { if (turn === generation) { completeSelect(pendingSelect, 'failed'); completeRefresh(pendingRefresh, 'failed'); } throw reason; } finally { try { finishRefresh(); } finally { --refreshesInFlight; } if (turn === generation) settledGeneration = turn; acknowledgeSelect(); acknowledgeRefresh(); }
  }
  async function newTab(privateMode=false) {
    if((reader.active||reader.busy)&&!await readerBeforeAction())return;
    cancelPendingFocus();
    const pending = { turn: focusGeneration, before: new Set(tabs.map(tab => tab.id)), ack: false, observed: null, expiresAt: window.Date.now() + 10_000 }, had = tabs.length > 0;
    pendingNewTab = pending;
    try {
      if (!isActive()) await enterBrowser();
      if (pendingNewTab !== pending || !isActive() || getView() !== 'browser') { if (pendingNewTab === pending) cancelPendingFocus(); return; }
      if (privateMode||had) await run(privateMode?'browser_new_private_tab':'browser_new_tab', { url: null });
      if (pendingNewTab !== pending) return;
      pending.ack = true;
      if (!isActive() || getView() !== 'browser') { cancelPendingFocus(); return; }
      await focusNewTab();
    } catch (reason) { if (pendingNewTab === pending) cancelPendingFocus(); throw reason; }
  }
  async function newPrivateTab(){
    if(privateNewPending||!isActive()||getView()!=='browser'||composing||tabComposing)return;
    privateNewPending=true;try{await newTab(true);}finally{privateNewPending=false;}
  }

  async function restore() {
    if((reader.active||reader.busy)&&!await readerBeforeAction())return;
    if (!isActive()) await enterBrowser();
    await run('browser_restore_tab'); menu.hidden = true;
  }
  async function zoom(delta) {
    const value = delta === 0 ? 1 : Math.round(((active()?.zoom ?? 1) + delta) * 100) / 100;
    await run('browser_zoom', { factor: Math.min(3, Math.max(.5, value)) }); await refresh();
  }
  function showFind() { ++findRevision;if(reader.busy||reader.active&&!reader.searchReady)return;findReader=reader.active;cancelPendingMenu(); hideSuggestions(); menu.hidden = true; findBar.hidden = false; $('#browser-find-query').focus(); $('#browser-find-query').select(); }
  async function find(backwards = false) {
    const query = $('#browser-find-query').value, request=++findRevision;
    if(reader.active){
      $('#browser-find-status').textContent='';
      const result=reader.find(query,backwards);findReader=true;
      $('#browser-find-status').textContent=query?result.found?`${result.current} / ${result.total}`:'見つかりません':'';return;
    }
    if(reader.busy||!isActive()||getView()!=='browser')return;
    if (!query) { $('#browser-find-status').textContent = ''; return; }
    const tab=active(),source=tab?controlSource(tab):null;
    const current=()=>request===findRevision&&!findBar.hidden&&!reader.active&&!reader.busy&&source&&controlCurrent(source)&&active()?.printContextToken===source.contextToken&&$('#browser-find-query').value===query;
    if(!source||!validPrintToken(source.contextToken)||!pageUrl(source.url)){ $('#browser-find-status').textContent='ページの準備ができてから検索してください。';return; }
    $('#browser-find-status').textContent='検索中…';
    try{
      const found=await run('browser_find',{id:source.id,query,backwards,expectedUrl:source.url,expectedContextToken:source.contextToken});
      if(current())$('#browser-find-status').textContent=found?'一致箇所を表示':'見つかりません';
    }catch(reason){if(current()){$('#browser-find-status').textContent='検索結果を確認できませんでした。';report(reason);}}
  }
  function showMenu(kind = menuKind) {
    protection.close();bookmarkBar?.close();
    if(reader.active||reader.busy){void reader.close().then(ok=>{if(ok!==false)showMenu(kind);});return;}
    cancelPendingMenu();
    privacyPanel = null; panels.closeMode(); menuKind = kind; hideSuggestions(); menu.replaceChildren(); menu.hidden = false;
    if (kind === 'site') { renderSiteInfo(); return; }
    if (kind === 'main') { renderMainMenu(); return; }
    // Braveと同じく、≡ は一覧。項目を選ぶとその画面が開き、上の「← メニュー」で一覧へ戻る。
    const head = document.createElement('div'); head.className = 'browser-menu-head browser-menu-back';
    const back = button('← メニュー', () => showMenu('main')); back.setAttribute('aria-label', 'メニューに戻る');
    const heading = document.createElement('strong'); heading.className = 'browser-menu-heading';
    heading.textContent = ({ tabs: '開いているタブ', history: '履歴', favorites: 'お気に入り', tools: 'その他の操作', privacy: '閲覧データとプライバシー', settings: '設定' })[kind] ?? '';
    head.append(back, heading); menu.append(head);
    if (kind === 'tabs') {
      const filter = document.createElement('input'); filter.id = 'browser-tab-menu-query'; filter.type = 'search'; filter.maxLength = 512; filter.className = 'browser-menu-filter'; filter.placeholder = 'タイトル・URLでタブを検索'; filter.value = tabQuery;
      filter.setAttribute('aria-label', '開いているタブを検索'); filter.setAttribute('role', 'combobox'); filter.setAttribute('aria-autocomplete', 'list'); filter.setAttribute('aria-controls', 'browser-tab-menu-results');
      const count = document.createElement('p'); count.id = 'browser-tab-menu-count'; count.setAttribute('role', 'status');
      const list = document.createElement('div'); list.id = 'browser-tab-menu-results'; list.className = 'browser-tab-results'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '開いているタブ');
      const empty = document.createElement('p'); empty.id = 'browser-tab-menu-empty'; empty.className = 'browser-menu-empty';
      menu.append(filter, count, list, empty); bindTabQuery(filter, true);
      renderTabResults = (preserveSelection = false) => {
        if (menuKind !== 'tabs' || menu.hidden || !menu.contains(filter)) return;
        const visible = filterBrowserTabs(tabs, tabQuery);
        if (preserveSelection) {
          const selectedId = Number(list.querySelector('[aria-selected="true"]')?.dataset.tabId);
          const selectedIndex = visible.findIndex(tab => tab.id === selectedId);
          if (selectedIndex >= 0) tabIndex = selectedIndex;
        }
        tabIndex = Math.min(tabIndex, Math.max(0, visible.length - 1));
        count.textContent = `${visible.length} / ${tabs.length} タブ`; empty.hidden = visible.length > 0; empty.textContent = tabs.length ? '一致するタブはありません' : '開いているタブはありません';
        filter.setAttribute('aria-expanded', String(visible.length > 0)); list.replaceChildren();
        visible.forEach((tab, index) => {
          const row = button('', () => { if (!menu.hidden && menu.contains(row) && getView() === 'browser') return chooseTab(tab.id); }, 'browser-menu-open'); row.id = `browser-tab-result-${tab.id}`; row.dataset.tabId = String(tab.id); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === tabIndex)); row.tabIndex = -1; row.classList.toggle('is-active', index === tabIndex); if (tab.active && isActive()) row.setAttribute('aria-current', 'page');
          const text = document.createElement('span'); text.className = 'browser-menu-text'; const title = document.createElement('strong'); title.className = 'browser-menu-title'; title.textContent = tab.title || pageUrl(tab.url)?.hostname || '新しいタブ'; title.title = title.textContent;
          const sub = document.createElement('small'); sub.className = 'browser-menu-sub'; sub.textContent = [tab.private && 'プライベート', tab.url || '新しいタブ', tab.group, tab.pinned && '固定', tab.discarded && '休止中'].filter(Boolean).join(' · '); sub.title = sub.textContent;
          text.append(title, sub); row.append(text); list.append(row);
        });
        if (visible[tabIndex]) filter.setAttribute('aria-activedescendant', `browser-tab-result-${visible[tabIndex].id}`); else filter.removeAttribute('aria-activedescendant');
      };
      renderTabResults(); filter.focus(); return;
    }
    if (kind === 'settings') { renderSettings(); return; }
    if (kind === 'favorites') {
      renderBrowserLibrary({document,window,host:menu,items:favorites,button,invoke:run,refresh,report,open:url=>choose({url}),bindOpen:(node,url,live)=>bindPageLink(node,{url},live)}); return;
    }
    if (kind === 'privacy') {
      privacyPanel = renderBrowserPrivacy({document,host:menu,button,invoke:run,refresh,report,tabs:()=>tabs}); return;
    }
    if (kind === 'tools') {
      const tools = document.createElement('div'); tools.className = 'browser-tools';
      tools.append(button(horizontalTabs ? '縦型タブに切り替え' : '横型タブに切り替え', () => {
        horizontalTabs = !horizontalTabs; tabQuery = ''; tabIndex = 0; if (tabInput) tabInput.value = '';
        try { window.localStorage.setItem('hub.browser.tabLayout', horizontalTabs ? 'horizontal' : 'vertical'); } catch { /* optional */ }
        placeTabs(); renderTabs(); menu.hidden = true;
      }), addressCandidates, button('URLをコピー', async () => { const url = active()?.url; if (!pageUrl(url)) return; try { await window.navigator.clipboard.writeText(url); menu.hidden = true; } catch { report(Error('browser_copy_unavailable')); } }), button('閉じたタブを復元', restore), sleepOthers(), button('ページ内検索', showFind), button('−', () => zoom(-.1)), button(`${Math.round((active()?.zoom ?? 1) * 100)}% · リセット`, () => zoom(0)), button('＋', () => zoom(.1)));
      panels.addTools(tools);
      const read=button('読みやすく表示',()=>reader.open());read.dataset.browserReader='true';read.disabled=Boolean(reader.busy||reader.active||!readerReady());tools.append(read);
      if(active())tools.append(browserControl('ページを印刷…','print',active()));
      const label = document.createElement('label'); label.textContent = 'Web検索の送信先 '; const select = document.createElement('select'); select.setAttribute('aria-label', 'Web検索の送信先');
      for (const [key, value] of Object.entries(SEARCH_ENGINES)) { const option = document.createElement('option'); option.value = key; option.textContent = value.label; select.append(option); }
      select.value = engine; select.onchange = () => { engine = select.value; try { window.localStorage.setItem('hub.browser.searchEngine', engine); } catch { /* optional */ } updateProvider(); };
      label.append(select); tools.append(label); menu.append(tools);
      const note = document.createElement('p'); note.className = 'browser-menu-empty'; note.textContent = '候補はこのPCのタブ・履歴・お気に入りから探します。入力中の文字は外部へ送信しません。'; menu.append(note); return;
    }
    const filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = 'タイトル・URLで絞り込む'; filter.setAttribute('aria-label', `${kind === 'history' ? '履歴' : 'お気に入り'}を絞り込む`); filter.className = 'browser-menu-filter'; menu.append(filter);
    const list = document.createElement('div'); menu.append(list);
    function render() {
      list.replaceChildren(); const q = filter.value.trim().toLocaleLowerCase(); const entries = (kind === 'history' ? history : favorites).filter(entry => pageUrl(entry.url) && `${entry.title ?? ''} ${entry.url}`.toLocaleLowerCase().includes(q));
      if (!entries.length) { const empty = document.createElement('p'); empty.className = 'browser-menu-empty'; empty.textContent = q ? '一致するページはありません' : 'ページはまだありません'; list.append(empty); }
      for (const entry of entries) {
        const row = document.createElement('div'); row.className = 'browser-menu-row'; const open = button('', () => choose(entry), 'browser-menu-open');
        const text = document.createElement('span'); text.className = 'browser-menu-text'; const title = document.createElement('strong'); title.className = 'browser-menu-title'; title.textContent = entry.title || pageUrl(entry.url).hostname;
        const sub = document.createElement('small'); sub.className = 'browser-menu-sub'; sub.textContent = entry.url; text.append(title, sub); open.append(text); bindPageLink(open, entry); row.append(open);
        if (kind === 'favorites') row.append(button('×', async () => { await run('browser_remove_favorite', { url: entry.url }); await refresh(); showMenu(kind); }, 'browser-tab-close'));
        if (kind === 'history') { const remove = button('×', async () => { await run('browser_delete_history_entry', { url: entry.url }); await refresh(); showMenu(kind); }, 'browser-tab-close'); remove.title = '履歴から削除'; remove.setAttribute('aria-label', `${entry.title || entry.url} を履歴から削除`); row.append(remove); }
        list.append(row);
      }
    }
    filter.oninput = render; render();
  }
  // ≡ のメニュー（Braveと同じ縦の一覧。左にアイコン、右にショートカット）。2026-10-12 ユーザー指定。
  function renderMainMenu() {
    const list = document.createElement('div'); list.className = 'browser-main-menu'; list.setAttribute('role', 'menu');
    const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const icons = {
      new: '<path d="M12 5v14M5 12h14"/>', restore: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5v4.2h4.2"/>', private: '<circle cx="8" cy="15" r="3"/><circle cx="16" cy="15" r="3"/><path d="M3 10h18M6 10l2-5h8l2 5M11 15h2"/>',
      history: '<path d="M3 11a9 9 0 1 1 2.5 7"/><path d="M3 5v6h6M12 7v5l3 2"/>', favorites: '<path d="m12 4 2.4 5 5.6.7-4.1 3.9 1 5.6-4.9-2.7-4.9 2.7 1-5.6L4 9.7l5.6-.7z"/>',
      bookmarks: '<path d="M7 4h10v16l-5-4-5 4z"/>', downloads: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>', tabs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
      zoom: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4M11 8.5v5M8.5 11h5"/>', find: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
      reader: '<path d="M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z"/>', print: '<path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z"/>',
      clear: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', settings: '<path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    };
    // 右のショートカットは CSS（data-keys）で出す。ボタンの文字は項目名だけにする。
    const dress = (node, icon, label, keys) => {
      node.className = 'browser-main-item'; node.setAttribute('role', 'menuitem'); node.textContent = '';
      const left = document.createElement('span'); left.className = 'browser-main-label'; left.innerHTML = svg(icons[icon]); left.append(document.createTextNode(label));
      node.append(left); if (keys) node.dataset.keys = keys; list.append(node); return node;
    };
    const item = (icon, label, keys, run, disabled = false) => { const node = dress(button('', run), icon, label, keys); node.disabled = disabled; return node; };
    const divider = () => { const line = document.createElement('div'); line.className = 'browser-main-divider'; line.setAttribute('role', 'separator'); list.append(line); };
    const close = () => { menu.hidden = true; };
    const page = active(), hasPage = Boolean(pageUrl(page?.url));
    item('new', '新しいタブ', 'Ctrl+T', async () => { close(); await newTab(); });
    item('restore', '閉じたタブを復元', 'Ctrl+Shift+T', async () => { close(); await restore().catch(report); });
    item('private', 'プライベートタブ', 'Ctrl+Shift+N', async () => { close(); await newPrivateTab(); });
    divider();
    item('history', '履歴', 'Ctrl+H', () => showMenu('history'));
    item('favorites', 'お気に入り', 'Ctrl+Shift+O', () => showMenu('favorites'));
    if (bookmarkBar) item('bookmarks', bookmarkBar.isVisible() ? 'ブックマークバーを隠す' : 'ブックマークバーを表示', 'Ctrl+Shift+B', () => { bookmarkBar.toggle(); close(); });
    item('downloads', 'ダウンロード', 'Ctrl+J', () => { close(); panels.showDownloads(); });
    item('tabs', '開いているタブを検索', 'Ctrl+Shift+A', () => showMenu('tabs'));
    divider();
    const zoomRow = document.createElement('div'); zoomRow.className = 'browser-main-item browser-main-zoom'; zoomRow.setAttribute('role', 'group'); zoomRow.setAttribute('aria-label', '拡大縮小');
    const zoomLabel = document.createElement('span'); zoomLabel.className = 'browser-main-label'; zoomLabel.innerHTML = svg(icons.zoom); zoomLabel.append(document.createTextNode('拡大縮小'));
    const zoomValue = document.createElement('span'); zoomValue.className = 'browser-main-zoom-value'; const paintZoom = () => { zoomValue.textContent = `${Math.round((active()?.zoom ?? 1) * 100)}%`; }; paintZoom();
    const minus = button('−', async () => { await zoom(-.1); paintZoom(); }, 'browser-main-zoom-button'); minus.setAttribute('aria-label', '縮小'); minus.disabled = !hasPage;
    const plus = button('＋', async () => { await zoom(.1); paintZoom(); }, 'browser-main-zoom-button'); plus.setAttribute('aria-label', '拡大'); plus.disabled = !hasPage;
    const zoomControls = document.createElement('span'); zoomControls.className = 'browser-main-keys'; zoomControls.append(minus, zoomValue, plus);
    zoomRow.append(zoomLabel, zoomControls); list.append(zoomRow);
    item('find', 'ページ内を検索', 'Ctrl+F', () => { close(); showFind(); }, !hasPage);
    const read = item('reader', '読みやすく表示', '', () => { close(); return reader.open(); }, Boolean(reader.busy || reader.active || !readerReady())); read.dataset.browserReader = 'true';
    // 印刷は既存の印刷操作（表示中のタブに固定して確認する）をそのまま使う。
    if (page) { const print = browserControl('ページを印刷…', 'print', page); const disabled = print.disabled; dress(print, 'print', 'ページを印刷…', 'Ctrl+P'); print.disabled = disabled; }
    divider();
    item('clear', '閲覧データを削除', '', () => showMenu('privacy'));
    item('more', 'その他の操作', '', () => showMenu('tools'));
    item('settings', '設定', '', () => showMenu('settings'));
    menu.append(list); list.querySelector('button:not(:disabled)')?.focus();
    list.onkeydown = (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const items = [...list.querySelectorAll('button:not(:disabled)')], at = items.indexOf(document.activeElement);
      event.preventDefault(); items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    };
  }
  // サイトの情報（アドレス欄の鍵から開く）。通信の状態、URLのコピー、権限、データの削除、保護。
  function renderSiteInfo() {
    const tab = active(), url = pageUrl(tab?.url), panel = document.createElement('div'); panel.className = 'browser-site-info';
    const title = document.createElement('strong'); title.className = 'browser-site-info-host'; title.textContent = url?.hostname || '新しいタブ';
    const state = document.createElement('p'); state.className = 'browser-menu-empty';
    state.textContent = !url ? 'ページを開くと、ここにサイトの情報が出ます。' : url.protocol === 'https:' ? '保護された通信です（HTTPS）。' : '保護されていない通信です（HTTP）。入力した内容が途中で読まれるおそれがあります。';
    const note = document.createElement('p'); note.className = 'browser-menu-empty'; note.setAttribute('role', 'status');
    panel.append(title, state);
    if (tab?.private) { const priv = document.createElement('p'); priv.className = 'browser-menu-empty'; priv.textContent = 'プライベートタブです。履歴とタブの復元に残りません。'; panel.append(priv); }
    const copy = button('URLをコピー', async () => { try { await window.navigator.clipboard.writeText(tab.url); note.textContent = 'URLをコピーしました。'; } catch { note.textContent = 'URLをコピーできませんでした。'; } });
    copy.disabled = !url;
    const permissions = button('サイトの権限', () => panels.showPermissions());
    const data = button('このサイトのデータを削除…', () => showMenu('privacy')); data.disabled = !url || Boolean(tab?.private);
    const shield = button('広告とトラッカーの保護', () => { menu.hidden = true; protection.button.click(); });
    panel.append(copy, permissions, data, shield, note); menu.append(panel); copy.focus();
  }
  // ブラウザの設定を1か所に（2026-10-12）。検索、ホーム、表示、保護、覚えた権限、閲覧データ、ショートカット。
  function renderSettings() {
    const panel = document.createElement('div'); panel.className = 'browser-settings';
    const section = (title) => { const head = document.createElement('h3'); head.className = 'browser-settings-head'; head.textContent = title; panel.append(head); };
    const note = (text) => { const p = document.createElement('p'); p.className = 'browser-menu-empty'; p.textContent = text; panel.append(p); return p; };
    const check = (label, checked, onchange) => { const row = document.createElement('label'); row.className = 'browser-settings-check'; const box = document.createElement('input'); box.type = 'checkbox'; box.checked = checked; box.onchange = () => onchange(box.checked); row.append(box, document.createTextNode(' ' + label)); panel.append(row); return box; };
    section('検索');
    const engineLabel = document.createElement('label'); engineLabel.className = 'browser-settings-field'; engineLabel.textContent = 'アドレス欄で使う検索エンジン ';
    const select = document.createElement('select'); for (const [key, value] of Object.entries(SEARCH_ENGINES)) { const option = document.createElement('option'); option.value = key; option.textContent = value.label; select.append(option); }
    select.value = engine; select.onchange = () => { engine = select.value; try { window.localStorage.setItem('hub.browser.searchEngine', engine); } catch { /* optional */ } updateProvider(); };
    engineLabel.append(select); panel.append(engineLabel);
    section('ホームと表示');
    check('ホームボタンを表示', homeSettings().show, value => { saveHome({ ...homeSettings(), show: value }); syncHome(); });
    const homeLabel = document.createElement('label'); homeLabel.className = 'browser-settings-field'; homeLabel.textContent = 'ホームページ ';
    const home = document.createElement('input'); home.type = 'url'; home.placeholder = 'https://'; home.value = homeSettings().url; home.maxLength = 2048;
    homeLabel.append(home); panel.append(homeLabel);
    const homeNote = note('');
    home.onchange = () => { const value = home.value.trim(); if (value && !pageUrl(value)) { homeNote.textContent = 'http:// か https:// で始まるアドレスを入れてください。'; return; } homeNote.textContent = ''; saveHome({ ...homeSettings(), url: value }); syncHome(); };
    if (bookmarkBar) check('ブックマークバーを表示', bookmarkBar.isVisible(), value => { if (bookmarkBar.isVisible() !== value) bookmarkBar.toggle(); });
    section('保護');
    panel.append(button('広告・トラッカーと自動再生の設定を開く', () => { menu.hidden = true; protection.button.click(); }));
    section('覚えているサイトの権限');
    const permissions = document.createElement('div'); permissions.className = 'browser-settings-list'; panel.append(permissions);
    const kinds = {1:'マイク',2:'カメラ',3:'位置情報',4:'通知',5:'センサー',6:'クリップボードの読み取り',7:'複数ファイルの自動ダウンロード',8:'ファイルの読み書き',9:'自動再生',10:'ローカルフォント',11:'MIDI',12:'ウィンドウの管理'};
    const listPermissions = async () => {
      let rows = []; try { rows = await invoke('browser_site_permissions'); } catch { rows = null; }
      permissions.replaceChildren();
      const empty = (text) => { const p = document.createElement('p'); p.className = 'browser-menu-empty'; p.textContent = text; permissions.append(p); };
      if (!Array.isArray(rows)) { empty('読み込めませんでした。'); return; }
      if (!rows.length) { empty('覚えている権限はありません。許可を聞かれたときに「このサイトでは次から聞かない」を選ぶと、ここに並びます。'); return; }
      for (const row of rows) {
        const line = document.createElement('div'); line.className = 'browser-menu-row';
        const text = document.createElement('span'); text.className = 'browser-menu-text';
        text.textContent = String(row.origin) + ' · ' + (kinds[row.kind] ?? '権限') + ' · ' + (row.decision === 'allow' ? '許可' : '拒否');
        line.append(text, button('取り消す', async () => { await run('browser_forget_site_permission', { origin: row.origin, kind: row.kind }); await listPermissions(); }, 'browser-tab-close'));
        permissions.append(line);
      }
    };
    void listPermissions();
    section('閲覧データの削除');
    note('すべてのサイトが対象です。ログイン中のサイトからはログアウトされます。');
    const clearNote = document.createElement('p'); clearNote.className = 'browser-menu-empty'; clearNote.setAttribute('role', 'status');
    const clear = (label, kinds, done) => {
      const start = button(label, () => { start.hidden = true; confirmButton.hidden = false; confirmButton.focus(); });
      const confirmButton = button('本当に' + label, async () => { confirmButton.disabled = true; try { await run('browser_clear_browsing_data', { kinds }); clearNote.textContent = done; } finally { confirmButton.hidden = true; confirmButton.disabled = false; start.hidden = false; } });
      confirmButton.hidden = true; panel.append(start, confirmButton);
    };
    clear('Cookieを削除', ['cookies'], 'Cookieを削除しました。');
    clear('キャッシュを削除', ['cache'], 'キャッシュを削除しました。');
    panel.append(clearNote);
    section('キーボードショートカット');
    const keys = document.createElement('dl'); keys.className = 'browser-settings-keys';
    for (const [key, label] of [['Ctrl+T','新しいタブ'],['Ctrl+W','タブを閉じる'],['Ctrl+Shift+T','閉じたタブを復元'],['Ctrl+Tab / Ctrl+Shift+Tab','次・前のタブ'],['Ctrl+PgUp / Ctrl+PgDn','前・次のタブ'],['Ctrl+1〜8 / Ctrl+9','タブを選ぶ / 最後のタブ'],['Ctrl+L / Alt+D / F6','アドレス欄'],['Ctrl+D','お気に入りに追加・解除'],['Ctrl+F','ページ内検索'],['Ctrl+P','印刷'],['Ctrl+Shift+A','タブを検索'],['Ctrl+Shift+B','ブックマークバー'],['Ctrl+Shift+N','プライベートタブ'],['Ctrl + / − / 0','拡大・縮小・元に戻す'],['Alt+← / Alt+→','戻る・進む'],['F5 / Ctrl+R','再読み込み'],['Ctrl+F5 / Ctrl+Shift+R','キャッシュを使わず再読み込み'],['Esc','読み込みを止める'],['F11','全画面']]) {
      const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = label; keys.append(dt, dd);
    }
    panel.append(keys); menu.append(panel); select.focus();
  }
  // ホームボタン（Braveと同じく既定では出さない）。ホームページが空なら出さない。
  const HOME_KEY = 'hub.browser.home';
  function homeSettings() { try { const value = JSON.parse(window.localStorage.getItem(HOME_KEY) || '{}'); return { show: value.show === true, url: typeof value.url === 'string' && pageUrl(value.url) ? value.url : '' }; } catch { return { show: false, url: '' }; } }
  function saveHome(value) { try { window.localStorage.setItem(HOME_KEY, JSON.stringify({ show: value.show === true, url: value.url || '' })); } catch { /* optional */ } }
  const homeButton = document.createElement('button'); homeButton.id = 'browser-home'; homeButton.type = 'button'; homeButton.title = 'ホーム'; homeButton.setAttribute('aria-label', 'ホーム');
  homeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/></svg>';
  homeButton.onclick = () => { const { url } = homeSettings(); if (url) void run('browser_navigate', { url }).catch(report); };
  $('#browser-navigation').before(homeButton);
  function syncHome() { const value = homeSettings(); homeButton.hidden = !(value.show && value.url); }
  syncHome();
  function updateProvider() { if (!Object.hasOwn(SEARCH_ENGINES, engine)) engine = 'google'; input.placeholder = `Webアドレス または ${SEARCH_ENGINES[engine].label}で検索`; input.setAttribute('aria-description', `検索を確定すると${SEARCH_ENGINES[engine].label}へ送信します。候補はこのPC内で探します。`); }
  const addressCandidates = button('アドレスを編集・候補を表示', async () => {
    cancelPendingFocus(); const turn = focusGeneration, id = active()?.id;
    await invoke('browser_focus_controls');
    if (turn !== focusGeneration || active()?.id !== id || !isActive() || getView() !== 'browser') return;
    menu.hidden = true; $('#browser-form').hidden = false;
    $('#browser-navigation').classList.remove('native-backed'); bindAddressDraft();input.focus(); input.select(); showSuggestions();
  });
  addressCandidates.id = 'browser-address-candidates';
  function setNativeChrome(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, 'enabled') || typeof payload.enabled !== 'boolean' || payload.enabled && (!isActive() || getView() !== 'browser') || nativeChrome === payload.enabled) return;
    nativeChrome = payload.enabled; if (!nativeChrome) nativeDraftTab = null; ++nativeChromeGeneration; pendingNativeAddress = null;
    $('#browser-navigation').classList.toggle('native-backed',nativeChrome && document.activeElement !== input);

    $('#browser-form').hidden = false;
    if (nativeChrome && document.activeElement !== input) hideSuggestions();
  }
  async function submitNativeAddress(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 2 || !Object.hasOwn(payload, 'value') || typeof payload.value !== 'string' || payload.value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(payload.value) || !Object.hasOwn(payload, 'tabId') || !Number.isSafeInteger(payload.tabId) || payload.tabId <= 0 || active()?.id !== payload.tabId || !nativeChrome || !isActive() || getView() !== 'browser' || composing || tabComposing || pendingNativeAddress || pendingSelect || pendingNewTab || selectionsInFlight) return;
    const entry = nativeDraftTab === payload.tabId && input.value === payload.value && suggestionIndex >= 0 ? candidates[suggestionIndex] : null;
    const target = entry?.url ?? navigationTarget(payload.value, engine); if (!target) return;
    nativeDraftTab = null;
    if((reader.active||reader.busy)&&!await readerBeforeAction())return;
    cancelPendingFocus();
    const request = { tabId: payload.tabId, chrome: nativeChromeGeneration, focus: focusGeneration }; pendingNativeAddress = request; ++selectionsInFlight;
    try {
      panels.closeMode(); hideSuggestions(); menu.hidden = true;
      await run(entry?.kind === 'tab' ? 'browser_activate_tab' : 'browser_navigate_from_address', entry?.kind === 'tab' ? { id: entry.id } : { id: request.tabId, url: target });
      if (pendingNativeAddress !== request || !nativeChrome || nativeChromeGeneration !== request.chrome || focusGeneration !== request.focus || !isActive() || getView() !== 'browser' || active()?.id !== request.tabId) return;
      await refresh();
    } catch (reason) { if (pendingNativeAddress === request && nativeChrome && nativeChromeGeneration === request.chrome && focusGeneration === request.focus && isActive() && getView() === 'browser' && active()?.id === request.tabId) report(reason); } finally { --selectionsInFlight; if (pendingNativeAddress === request) pendingNativeAddress = null; }
  }
  async function dispatch(action) {
    // F11: ブラウザの全画面（Rust側が窓を全画面にし、Esc で戻す）。
    if (action === 'fullscreen') return run('browser_toggle_fullscreen');
    if(action==='bookmarks-toggle'){if(isActive()&&getView()==='browser'&&!composing&&!tabComposing)bookmarkBar?.toggle();return;}
    if(action==='back'||action==='forward')return navigateHistory(action);
    if(action==='private-new'){await newPrivateTab();return;}
    if(action==='find'&&reader.active&&!reader.busy){showFind();return;}
    if(reader.active||reader.busy){if(['new','restore','close','next','previous','back','forward','reload','hard-reload'].includes(action)||action.startsWith('tab-')){if((reader.active||reader.busy)&&!await readerBeforeAction())return;}else return;}
    if(action==='print')return showPrint();
    if (action !== 'new') cancelPendingFocus();
    if (action === 'address') { if(!isActive() || getView() !== 'browser' || composing || tabComposing)return;const native = nativeChrome, turn = focusGeneration, menuTurn = menuGeneration, id = active()?.id, epoch = browserControlEpoch, chrome = nativeChromeGeneration;const current=()=>turn === focusGeneration && menuTurn === menuGeneration && epoch === browserControlEpoch && active()?.id === id && isActive() && getView() === 'browser' && !composing && !tabComposing;if (native) { $('#browser-navigation').classList.add('native-backed'); hideSuggestions(); }try{await invoke(native ? 'browser_focus_address' : 'browser_focus_controls');}catch(reason){if(current())throw reason;return;}if(!current() || native && chrome !== nativeChromeGeneration || nativeChrome) return; bindAddressDraft();input.focus(); input.select(); showSuggestions(); }
    else if (action === 'tabs') { if (getView() !== 'browser' || !isActive() || composing || tabComposing) return; const turn = menuGeneration; await invoke('browser_focus_controls'); if (turn === menuGeneration && getView() === 'browser' && isActive() && !composing && !tabComposing) showMenu('tabs'); }
    else if (action === 'tabs-close') menu.hidden = true;
    else if (action === 'history' || action === 'favorites') { if (getView() !== 'browser' || !isActive() || composing || tabComposing) return; await invoke('browser_focus_controls'); showMenu(action); }
    else if (action === 'downloads') { if (getView() !== 'browser' || !isActive()) return; await invoke('browser_focus_controls'); panels.showDownloads(); }
    else if (action === 'find') { if(!isActive() || getView() !== 'browser' || composing || tabComposing)return;const turn = focusGeneration, menuTurn = menuGeneration, id = active()?.id, epoch = browserControlEpoch;const current=()=>turn === focusGeneration && menuTurn === menuGeneration && epoch === browserControlEpoch && active()?.id === id && isActive() && getView() === 'browser' && !composing && !tabComposing;try{await invoke('browser_focus_controls');}catch(reason){if(current())throw reason;return;}if(current())showFind(); }
    else if (action === 'new') await newTab();
    else if (action === 'restore') await restore();
    else if (action === 'close' && active()) await run('browser_close_tab', { id: active().id });
    else if (action === 'next' || action === 'previous' || action.startsWith('tab-')) {
      const index = action === 'next' ? (tabs.indexOf(active()) + 1) % tabs.length : action === 'previous' ? (tabs.indexOf(active()) - 1 + tabs.length) % tabs.length : action === 'tab-9' ? tabs.length - 1 : Number(action.slice(4)) - 1;
      if (tabs[index]) await run('browser_activate_tab', { id: tabs[index].id });
    } else if (action === 'zoom-in') await zoom(.1);
    else if (action === 'zoom-out') await zoom(-.1);
    else if (action === 'zoom-reset') await zoom(0);
    else if (action==='reload') await run('browser_reload');
    else if (action==='hard-reload') await run('browser_hard_reload');
    else if (action==='stop') await run('browser_stop');
    else if (action==='favorite') { const fav=$('#browser-fav'); if(isActive()&&getView()==='browser'&&fav&&!fav.disabled)fav.click(); }
  }
  $('#browser-form').onsubmit = async event => {
    event.preventDefault();
    if (composing || event.isComposing || event.keyCode === 229) return;
    const tabId = addressDraftTab;let attempted=false;
    try { if(tabId === null || tabId !== active()?.id || !isActive() || getView() !== 'browser')throw Error('browser_tab_context_changed');const target = navigationTarget(input.value, engine); if (target) {attempted=true;await choose(suggestionIndex >= 0 ? candidates[suggestionIndex] : { url: target }, 'current', tabId);} } catch (reason) { if(isActive() && getView() === 'browser' && active()?.id === tabId){report(reason);input.focus();}else if(!attempted && isActive() && getView() === 'browser')report(reason); }
  };
  input.addEventListener("compositionstart", () => { completeSelect(pendingSelect, 'failed'); completeRefresh(pendingRefresh, 'failed'); cancelPendingMenu(); composing = true; }); input.addEventListener("compositionend", () => { composing = false; });
  function bindAddressDraft(){const tab = active();if(addressDraftTab !== tab?.id)input.value = tab?.url ?? '';addressDraftTab = tab?.id ?? null;}
  input.onfocus = () => {bindAddressDraft();showSuggestions();}; input.oninput = () => { addressDraftTab = active()?.id ?? null;cancelPendingMenu(); error.hidden = true; showSuggestions(); };
  input.addEventListener('pointerdown',bindAddressDraft);
  input.onkeydown = event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      try { const tabId = addressDraftTab;if(tabId === null || tabId !== active()?.id)throw Error('browser_tab_context_changed');const url = navigationTarget(input.value, engine); if (url) void choose({url}, 'foreground', tabId).catch(report); } catch (reason) { report(reason); }
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      // Ctrl+Enter: 単語に www. と .com を補って開く。単語でなければ普通の Enter と同じ。
      const url = completeDotCom(input.value);
      if (url) { event.preventDefault(); const tabId = addressDraftTab; if (tabId !== null && tabId === active()?.id) void choose({url}, 'current', tabId).catch(report); else report(Error('browser_tab_context_changed')); }
    } else if (event.key === 'Escape') {
      // Chrome と同じ二段: 編集中なら元のURLへ戻して選択したまま、戻っていればフォーカスを外す。
      event.preventDefault(); hideSuggestions();
      const original = active()?.url ?? '';
      if (input.value !== original) { input.value = original; addressDraftTab = active()?.id ?? null; input.select(); }
      else input.blur();
    }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && candidates.length) { event.preventDefault(); if (suggestions.hidden) showSuggestions(); selectSuggestion(suggestionIndex < 0 ? event.key === 'ArrowDown' ? 0 : candidates.length - 1 : (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); }
  };
  document.addEventListener('keydown', event => {
    if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('dialog[open]')&&!event.isComposing&&event.keyCode!==229&&(reader.active||reader.busy)){event.preventDefault();void reader.close();return;}
    if (event.defaultPrevented || getView() !== 'browser' || composing || tabComposing || event.isComposing || event.keyCode === 229) return;
    const action = (event.ctrlKey||event.metaKey)&&event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='b'?'bookmarks-toggle':(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='p'?'print':browserShortcut(event); if (action === 'fullscreen' && event.repeat) { event.preventDefault(); return; } if (action) { event.preventDefault();if(event.repeat&&['private-new','bookmarks-toggle'].includes(action))return;void dispatch(action).catch(report); }
    else if (event.key === 'Escape') {
      // 何も開いていなければ、読み込み中のページを止める（Chrome と同じ）。
      const stop = menu.hidden && findBar.hidden && suggestions.hidden && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && active()?.loading === true;
      // 検索バーは閉じるボタンと同じ後始末（ハイライトと件数を消す）をする。
      menu.hidden = true; if (!findBar.hidden) $('#browser-find-close').click(); findBar.hidden = true; hideSuggestions();
      if (stop) void dispatch('stop').catch(report);
    }
  });
  // タブ一覧の空いたところをダブルクリックすると新しいタブ（Chrome のタブ帯と同じ）。
  { const list = $('#sidebar-tabs-list'); if (list) list.addEventListener('dblclick', event => { if (event.target === list && isActive() && getView() === 'browser') { event.preventDefault(); void newTab().catch(report); } }); }
  document.addEventListener('click', event => { if (!event.composedPath().includes($('#browser-form')) && !event.composedPath().includes(suggestions)) hideSuggestions(); });
  input.onblur = () => window.setTimeout(() => { if (!suggestions.contains(document.activeElement)) hideSuggestions(); }, 0);
  $('#browser-back').onclick = () => void dispatch('back').catch(report); $('#browser-forward').onclick = () => void dispatch('forward').catch(report);
  $('#browser-reload').onclick = () => void (async()=>{if((reader.active||reader.busy)&&!await readerBeforeAction())return;await run(active()?.loading?'browser_stop':'browser_reload');})().catch(report);
  $('#browser-new-tab').onclick = () => void newTab().catch(report);
  $('#sidebar-new-tab').onclick = () => void newTab().catch(report); $('#browser-restore').onclick = () => void restore().catch(report);
  $('#browser-fav').onclick = async () => { try { await run(favorites.some(entry => entry.url === active()?.url) ? 'browser_remove_favorite' : 'browser_add_favorite', { url: active()?.url }); await refresh(); } catch (reason) { report(reason); } };
  if (tabInput) bindTabQuery(tabInput);
  if ($('#browser-tab-search')) $('#browser-tab-search').onclick = () => { if (getView() !== 'browser') return; if (menu.hidden || menuKind !== 'tabs' || !$('#browser-tab-menu-query')) showMenu('tabs'); else menu.hidden = true; };
  $('#browser-history').onclick = () => menu.hidden || menuKind !== 'history' ? showMenu('history') : menu.hidden = true;
  $('#browser-tools').onclick = () => menu.hidden || menuKind !== 'main' ? showMenu('main') : menu.hidden = true;
  $('#browser-zoom').onclick = () => showMenu('tools'); $('#browser-find').onclick = showFind;
  // Shift+Enter は前の一致へ（Chrome と同じ）。Esc は文書側で検索バーを閉じる。
  $('#browser-find-query').addEventListener('keydown', event => { if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void find(true).catch(report); } });
  $('#browser-find-form').onsubmit = event => { event.preventDefault(); void find().catch(report); };
  $('#browser-find-previous').onclick = () => void find(true).catch(report); $('#browser-find-next').onclick = () => void find().catch(report);
  $('#browser-find-close').onclick = () => {++findRevision; reader.clearFind();findReader=false;findBar.hidden = true;$('#browser-find-status').textContent=''; };
  let aiPending = false, aiScope = 0;
  for (const name of ['hub-account-changed', 'hub-origin-changed']) window.addEventListener(name, () => { aiScope++; });
  async function sendToAi(context, markPhase) {
    const mark = phase => { try { Promise.resolve(markPhase?.(phase)).catch(() => {}); } catch {} };
    if (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context)
      || Reflect.ownKeys(context).length !== 3 || !['tabId', 'url', 'isCurrent'].every(key => Object.hasOwn(context, key))
      || !Number.isSafeInteger(context.tabId) || context.tabId <= 0 || typeof context.url !== 'string'
      || context.url.length > 8192 || pageUrl(context.url)?.href !== context.url || typeof context.isCurrent !== 'function')) { mark('source_changed'); return false; }
    context = context === undefined ? undefined : {tabId: context.tabId, url: context.url, isCurrent: context.isCurrent};
    const contextCurrent = () => { try { return context === undefined || context.isCurrent() === true; } catch { return false; } };
    if (aiPending) return false;
    if (!Number.isSafeInteger(active()?.id) || active().id <= 0 || !isActive() || getView() !== 'browser' || !pageUrl(active()?.url) || !contextCurrent()
      || context && (active()?.id !== context.tabId || active()?.url !== context.url)) { mark('source_changed'); return false; }
    const source = { id: active().id, url: active().url, title:Array.from(active().title??'').slice(0,240).join(''), epoch: browserControlEpoch, focus: focusGeneration, scope: aiScope };
    const current = () => contextCurrent() && aiScope === source.scope && isActive() && getView() === 'browser'
      && browserControlEpoch === source.epoch && focusGeneration === source.focus && active()?.id === source.id && active()?.url === source.url;
    let staging = false;
    aiPending = true; $('#browser-ai').disabled = true;
    try {
      mark('extracting');
      const draft = await run('browser_send_to_ai', { id: source.id, url: source.url });
      if (!current()) { mark('source_changed'); return false; }
      staging = true; mark('staging');
      const accepted = await onAiDraft(draft, {isCurrent: current,reference:{title:source.title,url:source.url,text:draft}}) === true;
      mark(accepted ? 'accepted' : current() ? 'draft_refused' : 'source_changed');
      return accepted;
    } catch (reason) {
      const valid = current();
      mark(valid ? staging ? 'draft_failed' : 'extract_failed' : 'source_changed');
      if (valid) report(reason); return false;
    }
    finally { aiPending = false; displayActive(); }
  }
  $('#browser-ai').onclick = () => sendToAi();
  const localGamesButton = $('#browser-local-games'); if (localGamesButton) localGamesButton.onclick = () => onLocalGames();
  window.__TAURI__.event.listen('browser-native-address-edit', event => {
    const p = event.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Reflect.ownKeys(p).length !== 2 || !Object.hasOwn(p, 'tabId') || !Object.hasOwn(p, 'value') || !Number.isSafeInteger(p.tabId) || p.tabId <= 0 || p.tabId !== active()?.id || typeof p.value !== 'string' || p.value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(p.value) || !nativeChrome || !isActive() || getView() !== 'browser' || composing || tabComposing) return;
    ++nativeEditTurn; nativeDraftTab = p.tabId;addressDraftTab = p.tabId; input.value = p.value; showSuggestions();
  });
  window.__TAURI__.event.listen('browser-native-address-key', event => {
    const p = event.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Reflect.ownKeys(p).length !== 2 || !Object.hasOwn(p, 'tabId') || !Object.hasOwn(p, 'key') || p.tabId !== active()?.id || !Number.isSafeInteger(p.tabId) || !nativeChrome || !isActive() || getView() !== 'browser' || !['ArrowDown', 'ArrowUp', 'Escape', 'blur'].includes(p.key)) return;
    if (p.key === 'blur') {
      const turn = ++nativeEditTurn;
      window.setTimeout(() => { if (turn === nativeEditTurn && !suggestions.contains(document.activeElement)) { nativeDraftTab = null; hideSuggestions(); } }, 100);
      return;
    }
    if (p.key === 'Escape') { ++nativeEditTurn; nativeDraftTab = null; hideSuggestions(); return; }
    if (suggestions.hidden) showSuggestions();
    if (candidates.length) selectSuggestion(suggestionIndex < 0 ? p.key === 'ArrowDown' ? 0 : candidates.length - 1 : (suggestionIndex + (p.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length);
  });
  window.__TAURI__.event.listen('browser-native-chrome', event => setNativeChrome(event.payload));
  window.__TAURI__.event.listen('browser-native-address-submit', event => void submitNativeAddress(event.payload).catch(report));
  window.__TAURI__.event.listen('browser-control-refresh', event => controlRefresh(event.payload));
  window.__TAURI__.event.listen('hub:browser-probe-profile', event => setProbeProfile(event.payload));
  window.__TAURI__.event.listen('browser-tabs-changed', () => void refresh(true).then(()=>autoplay.paint()).catch(report));
  window.__TAURI__.event.listen('browser-url-changed', () => { ++findRevision;void reader.invalidate();hideSuggestions(); error.hidden = true; $('#browser-blocked').hidden = true; $('#browser-find-status').textContent = ''; void refresh().then(()=>autoplay.paint()); });
  window.__TAURI__.event.listen('browser-reader-closed',event=>reader.handleClosed(event.payload));
  window.__TAURI__.event.listen('browser-shortcut', event => { if (event.payload!=='print' && getView() === 'browser' && (event.payload === 'tabs-close' || !composing && !tabComposing)) void dispatch(event.payload).catch(report); });
  window.__TAURI__.event.listen('browser-print-request', event => void requestPrint(event.payload));
  // ページの右クリック「…をWebで検索」。検索先は設定の検索エンジン。新しいタブは元のタブのプライベート状態を引き継ぐ（Rust側）。
  window.__TAURI__.event.listen('browser-search-selection', event => {
    const p = event.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Reflect.ownKeys(p).length !== 2 || !Number.isSafeInteger(p.tabId) || p.tabId <= 0 || p.tabId !== active()?.id || typeof p.text !== 'string' || p.text.length > 8192 || !isActive() || getView() !== 'browser') return;
    const url = selectionSearchUrl(p.text, engine);
    if (url) void run('browser_open_tab', { url, foreground: true }).then(refresh).catch(report);
  });
  window.__TAURI__.event.listen('browser-control-select', event => {
    if (typeof event.payload === 'object') { controlSelect(event.payload); return; }
    if (getView() === 'browser' && isActive() && Number.isSafeInteger(event.payload) && event.payload > 0 && !composing && !tabComposing) void chooseTab(event.payload).catch(report);
  });
  window.__TAURI__.event.listen('browser-operation-error', event => report(event.payload));
  for (const name of ['pointerdown', 'click', 'keydown']) document.addEventListener(name, event => { if(event.type==='keydown'&&event.repeat&&browserShortcut(event)==='private-new')return;if (pendingNewTab) cancelPendingFocus(); else cancelPendingMenu(); }, true);
  document.addEventListener('focusin', event => { if (pendingNewTab && !(pendingNewTab.focusing && event.target === pendingNewTab.returnFocus)) cancelPendingFocus(); }, true);
  new window.MutationObserver(() => $('#browser-tools').setAttribute('aria-expanded', String(!menu.hidden))).observe(menu, {attributes:true,attributeFilter:['hidden']});
  // メニューはページの右上に重ねて出す（Braveと同じ）。ページの切り抜きは実測した矩形のまま browser-page-holes.mjs が行う。
  function syncMenuOverlay() {
    const stage = $('#browser-stage')?.getBoundingClientRect();
    if (menu.hidden || !stage || !(stage.width > 0)) return;
    menu.style.setProperty('--menu-top', Math.round(stage.top + 6) + 'px');
    menu.style.setProperty('--menu-right', Math.round(window.innerWidth - stage.right + 8) + 'px');
  }
  let menuOverlayFrame = null;
  const scheduleMenuOverlay = () => { if (menuOverlayFrame !== null) return; menuOverlayFrame = (window.requestAnimationFrame?.bind(window) ?? (callback => window.setTimeout(callback, 16)))(() => { menuOverlayFrame = null; syncMenuOverlay(); }); };
  new window.MutationObserver(scheduleMenuOverlay).observe(menu, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
  window.addEventListener('resize', scheduleMenuOverlay);
  { const stage = $('#browser-stage'); if (stage && typeof window.ResizeObserver === 'function') new window.ResizeObserver(scheduleMenuOverlay).observe(stage); }
  // All toolbar controls belong to the bundled UI; retire any separate native overlay.
  void invoke('native_browser_chrome_layout', {rect:null,palette:null,fontSize:13}).catch(report);
  updateProvider(); void refresh();
  const captureNavigationIntent = () => { const focus=focusGeneration,menuTurn=menuGeneration;return()=>focus===focusGeneration&&menuTurn===menuGeneration&&isActive()&&getView()==='browser'&&!composing&&!tabComposing; };
  return { refresh, dispatch, cancelPendingFocus, captureNavigationIntent, syncNavigation, sendToAi, closeAuxiliary:()=>{protection.invalidate();bookmarkBar?.close();} };
}

// Hub のゲーム一覧（/v2/games）を開いているときだけ、このPCのゲーム起動口を出す。
const HUB_GAMES_HOSTS = new Set(['hub.jkamma.com', 'localhost:3020', '127.0.0.1:3020']);
export function isHubGamesUrl(value) {
  try {
    const url = new URL(value);
    return HUB_GAMES_HOSTS.has(url.host) && !url.username && !url.password && /^\/v2\/games(\/|$)/.test(url.pathname);
  } catch { return false; }
}
