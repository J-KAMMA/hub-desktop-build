const definitions = [
  [1,"feed","おすすめ"],[2,"feed","人気"],[3,"feed","フォロー中"],
  [4,"notifications","すべて"],[5,"notifications","未読"],[6,"notifications","フィード"],[7,"notifications","コミュニティ"],[8,"notifications","お知らせ"],
  [9,"market","商品"],[10,"market","出品"],[11,"market","販売者"],
  [12,"settings","Desktopアカウント"],[13,"settings","この端末"],[14,"settings","通知と受信"],[15,"settings","その他の設定"],
];
const selectors = ["#view-feed [data-scope=\"recommended\"]", "#view-feed [data-scope=\"popular\"]", "#view-feed [data-scope=\"following\"]", "#view-notifications [data-notif-tab=\"all\"]", "#view-notifications [data-notif-tab=\"unread\"]", "#view-notifications [data-notif-tab=\"feed\"]", "#view-notifications [data-notif-tab=\"community\"]", "#view-notifications [data-notif-tab=\"system\"]", "#view-market [data-shop-tab=\"products\"]", "#view-market [data-shop-tab=\"listings\"]", "#view-market [data-shop-tab=\"seller\"]", "[data-settings-sec=\"account\"]", "[data-settings-sec=\"device\"]", "[data-settings-sec=\"notifications\"]", "[data-settings-sec=\"other\"]"];
export const nativeSidebarId = (view,selector) => definitions.find(([id,v])=>v===view && selectors[id-1]===selector)?.[0] ?? 0;
const byId = new Map(definitions.map(([id,view,label])=>[id,{view,label}]));
const views = new Set(definitions.map(([,view])=>view));
const shape = (value,keys) => value && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const safe = value => Number.isSafeInteger(value) && value > 0;

export function initNativeSidebar({document,window,invoke,listen,getView,eligible}) {
  const context = document.querySelector("#sidebar-context"), sidebar = document.querySelector(".sidebar"), shell = document.querySelector(".app-shell");
  let revision=0, ready=false, destroyed=false, busy=false, dirty=false, frame=null, latest=null, acknowledged=[], lastColors=null, lastView="feed", lastTypography={fontSize:14,paddingX:0,radius:0,fontWeight:600}, exhausted=false, lastPayload=null, lastSentRevision=0, registrationFailed=false;
  const original = new Map(), unlisten=[], observed=new Set();
  const restore = () => {
    for (const [node,properties] of original) for (const [name,value,priority] of properties) {
      if (value) node.style.setProperty(name,value,priority); else node.style.removeProperty(name);
    }
    original.clear(); acknowledged=[];
  };
  const visible = node => {
    if (!node?.isConnected || node.closest("[hidden]")) return false;
    for (let current=node;current;current=current.parentElement) {
      const style=window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const allowed = () => !destroyed && !exhausted && eligible() && document.visibilityState === "visible" && views.has(getView()) && !shell.classList.contains("browser-active") && !document.querySelector('dialog[open]') && !document.body.classList.contains("column-resizing") && visible(context) && visible(sidebar);
  const rectOf = node => {
    if (!visible(node) || node.disabled || document.activeElement===node || node.contains(document.activeElement)) return null;
    const r=node.getBoundingClientRect(), c=context.getBoundingClientRect(), s=sidebar.getBoundingClientRect();
    if (![r.x,r.y,r.width,r.height,c.x,c.y,c.width,c.height,s.x,s.y,s.width,s.height].every(Number.isFinite) || r.x<0 || r.y<0 || r.x>32767 || r.y>32767 || r.width<1 || r.width>1000 || r.height<1 || r.height>100 || c.width<1 || c.height<1 || s.width<1 || s.height<1 || r.x<Math.max(c.x,s.x,0) || r.y<Math.max(c.y,s.y,0) || r.x+r.width>Math.min(c.x+c.width,s.x+s.width,window.innerWidth) || r.y+r.height>Math.min(c.y+c.height,s.y+s.height,window.innerHeight)) return null;
    return {x:r.x,y:r.y,w:r.width,h:r.height};
  };
  const collect = () => {
    if (!allowed()) return [];
    const rows=[], ids=new Set(), view=getView();
    for (const node of context.querySelectorAll('button[data-native-sidebar-id]')) {
      const id=Number(node.dataset.nativeSidebarId), definition=byId.get(id);
      if (!definition || String(id)!==node.dataset.nativeSidebarId || definition.view!==view || ids.has(id)) return [];
      ids.add(id);
      const label=node.textContent, rect=rectOf(node);
      if (label!==definition.label || label.length>128 || /[\u0000-\u001f\u007f-\u009f]/u.test(label)) return [];
      if (rect) rows.push({id,label,selected:node.classList.contains("on"),rect,node});
    }
    return rows.length<=5 ? rows : [];
  };
  const colors = () => {
    const style=window.getComputedStyle(context);
    const parse = token => {
      const value=style.getPropertyValue(token).trim();
      if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value)) {
        const hex=value.length===4?[...value.slice(1)].map(x=>x+x).join(""):value.slice(1);
        return [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)).concat(1);
      }
      const match=value.match(/^rgba?\(([^)]+)\)$/i); if (!match) return null;
      const values=match[1].trim().split(/[\s,\/]+/).map(Number); if(values.length===3)values.push(1);
      return values.length===4 && values.every(Number.isFinite) && values.slice(0,3).every(x=>x>=0&&x<=255) && values[3]>=0 && values[3]<=1 ? values : null;
    };
    const background=parse("--panel"), values=[parse("--interactive"),parse("--selected"),parse("--text"),parse("--muted")];
    if (!background || background[3]!==1 || values.some(value=>!value)) return null;
    const blend=value=>value.slice(0,3).map((x,i)=>Math.round(x*value[3]+background[i]*(1-value[3])));
    return Object.fromEntries(["background","hover","selected","text","muted"].map((name,i)=>[name,i?blend(values[i-1]):background.slice(0,3).map(Math.round)]));
  };
  const sameRows = rows => latest && rows.length===latest.rows.length && rows.every((row,index)=>{
    const old=latest.rows[index];return row.node===old.node && row.id===old.id && row.label===old.label && row.selected===old.selected && Object.keys(row.rect).every(key=>row.rect[key]===old.rect[key]);
  });
  const hide = async () => {
    if(!lastPayload)return;
    if(revision<Number.MAX_SAFE_INTEGER)revision++;
    else if(lastSentRevision===revision)return;
    lastSentRevision=revision;
    try {await invoke("native_sidebar_sync",{...lastPayload,revision,rows:[]});}catch{}
  };
  const typography = node => {
    const style=window.getComputedStyle(node), fontSize=Number.parseFloat(style.fontSize),paddingX=Number.parseFloat(style.paddingLeft),right=Number.parseFloat(style.paddingRight),radius=Number.parseFloat(style.borderTopLeftRadius),fontWeight=Number(style.fontWeight);
    return Number.isFinite(fontSize)&&fontSize>=10&&fontSize<=24&&Number.isFinite(paddingX)&&paddingX>=0&&paddingX<=32&&paddingX===right&&Number.isFinite(radius)&&radius>=0&&radius<=20&&[style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius].every(value=>Number.parseFloat(value)===radius)&&Number.isInteger(fontWeight)&&fontWeight>=100&&fontWeight<=900 ? {fontSize,paddingX,radius,fontWeight} : null;
  };
  const send = async () => {
    if(busy || !ready || !dirty || destroyed)return;
    dirty=false; busy=true;
    try {
      if(!lastPayload&&!allowed())return;
      const currentColors=colors(); if(currentColors)lastColors=currentColors;
      const view=getView(); if(views.has(view))lastView=view;
      let rows=currentColors?collect():[];
      const currentTypography=rows.length?typography(rows[0].node):lastTypography;
      if(!currentTypography||rows.some(row=>JSON.stringify(typography(row.node))!==JSON.stringify(currentTypography)))rows=[];
      else lastTypography=currentTypography;
      const payload={view:lastView,revision,rows:rows.map(({node,...row})=>row),colors:lastColors,...lastTypography};
      latest={revision,view,rows,payload};
      if(lastColors){lastPayload=payload;lastSentRevision=revision;await invoke("native_sidebar_sync",payload);}
    } catch { restore();latest=null;await hide(); }
    finally {busy=false;if(destroyed)void hide();else if(dirty)schedule();}
  };
  const schedule = () => {
    if(!ready||busy||frame!==null||destroyed)return;
    frame=window.requestAnimationFrame(()=>{frame=null;void send();});
  };
  const sync = () => {
    if(destroyed)return;
    restore(); latest=null;
    if(exhausted)return;
    revision++;exhausted=revision===Number.MAX_SAFE_INTEGER;dirty=true;
    for(const node of observed)if(!context.contains(node)){observer?.unobserve(node);observed.delete(node);}
    for(const node of context.querySelectorAll('button[data-native-sidebar-id]'))if(!observed.has(node)){observer?.observe(node);observed.add(node);}
    schedule();
  };
  const onReady = value => {
    if(!shape(value,["revision","ids"])||!safe(value.revision)||!Array.isArray(value.ids)||value.ids.length>5||new Set(value.ids).size!==value.ids.length||value.ids.some(id=>!Number.isInteger(id)||!byId.has(id))||destroyed||!ready||value.revision!==revision||latest?.revision!==revision)return;
    if(value.ids.some(id=>!latest.rows.some(row=>row.id===id)))return;
    if(!sameRows(collect())){sync();return;}
    restore(); acknowledged=[...value.ids];
    for(const {id,node} of latest.rows)if(acknowledged.includes(id)) {
      original.set(node,["opacity","pointer-events"].map(name=>[name,node.style.getPropertyValue(name),node.style.getPropertyPriority(name)]));
      node.style.setProperty("opacity","0");node.style.setProperty("pointer-events","none");
    }
  };
  const onAction = value => {
    if(!shape(value,["revision","id"])||!safe(value.revision)||!Number.isInteger(value.id)||!acknowledged.includes(value.id)||destroyed||value.revision!==revision||latest?.revision!==revision||getView()!==latest.view)return;
    const rows=collect();if(!sameRows(rows)){sync();return;}
    const row=rows.find(row=>row.id===value.id);if(!row)return;
    sync();row.node.click();
  };
  const observer=typeof window.ResizeObserver==="function"?new window.ResizeObserver(sync):null;
  observer?.observe(context);observer?.observe(sidebar);
  const mutations=typeof window.MutationObserver==="function"?new window.MutationObserver(records=>{
    if(records.some(record=>record.type==="childList"?record.target===context||context.contains(record.target):record.target===shell||record.target===document.body||record.target===document.documentElement||record.target.matches?.('dialog')||context.contains(record.target)||sidebar===record.target))sync();
  }):null;
  mutations?.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["class","hidden","open","data-native-sidebar-id"]});
  const onFocus = event => {if(context.contains(event.target))sync();};
  context.addEventListener("scroll",sync,{passive:true});window.addEventListener("resize",sync);document.addEventListener("visibilitychange",sync);document.addEventListener("focusin",onFocus);document.addEventListener("focusout",onFocus);
  const stopListeners = () => {for(const fn of unlisten.splice(0))try{Promise.resolve(fn()).catch(()=>{});}catch{}};
  const register = (name,handler) => Promise.resolve(listen(name,handler)).then(fn=>{
    if(typeof fn!=="function")return;
    if(destroyed||registrationFailed){try{Promise.resolve(fn()).catch(()=>{});}catch{}}else unlisten.push(fn);
  });
  try {
    Promise.all([register("native-sidebar-ready",event=>onReady(event.payload)),register("native-sidebar-action",event=>onAction(event.payload))]).then(async()=>{
      if(destroyed)return;
      const floor=await invoke("native_sidebar_reset");
      if(destroyed)return;
      if(!safe(floor)||floor===Number.MAX_SAFE_INTEGER)throw Error("Native sidebar revision unavailable");
      revision=Math.max(revision,floor);
      if(revision===Number.MAX_SAFE_INTEGER)throw Error("Native sidebar revision exhausted");
      ready=true;sync();
    }).catch(()=>{registrationFailed=true;stopListeners();restore();});
  }catch{registrationFailed=true;stopListeners();restore();}
  return {sync,status(){
    const selected=[...context.querySelectorAll('button[data-native-sidebar-id].on')].map(node=>Number(node.dataset.nativeSidebarId)).find(id=>byId.get(id)?.view===getView())??0;
    return {revision,ids:[...acknowledged],selected};
  },destroy(){
    if(destroyed)return;destroyed=true;restore();dirty=false;
    if(frame!==null)window.cancelAnimationFrame(frame);frame=null;
    observer?.disconnect();mutations?.disconnect();observed.clear();stopListeners();
    context.removeEventListener("scroll",sync);window.removeEventListener("resize",sync);document.removeEventListener("visibilitychange",sync);document.removeEventListener("focusin",onFocus);document.removeEventListener("focusout",onFocus);
    if(!busy)void hide();
  }};
}
