// .v2 (2026-10-12): the pinned column became the default; earlier saved choices are not carried over.
const preference='hub.browser.verticalTabsPinned.v2';

/** Expands the tab sidebar over a fixed page stage; Native clips its child host. */
export function createBrowserVerticalTabs({document,window,shell,panel,pin,menu,isCurrent,isBlocked=()=>false,storage=window.localStorage,delay=220}){
  if(!shell||!panel||!pin||typeof isCurrent!=='function')throw Error('browser_vertical_tabs_invalid');
  const wide=window.matchMedia('(min-width:861px)'),sidebar=shell.querySelector('.sidebar');
  if(!sidebar)throw Error('browser_vertical_tabs_invalid');
  let pinned=false,hovered=false,dragging=false,destroyed=false,timer=null;
  // 既定は固定表示（タブの題名が読める幅）。細い帯にしたい人だけピンを外す。2026-10-12 ユーザー指定。
  try{pinned=storage?.getItem(preference)!=='0';}catch{pinned=true;}
  const eligible=()=>!destroyed&&wide.matches&&isCurrent()===true&&shell.classList.contains('browser-active')&&!shell.classList.contains('browser-tabs-horizontal')&&!shell.classList.contains('apps-active')&&!shell.classList.contains('sidebar-collapsed')&&panel.parentElement?.classList.contains('sidebar');
  const focused=()=>document.hasFocus()&&sidebar.contains(document.activeElement);
  // A drag holds the column open. The browser menu only keeps an already open column from closing: opening the
  // menu must not widen the column over the page (it covered the page's left edge while the menu was open).
  const blocked=()=>dragging||isBlocked()===true;
  const retained=()=>menu?.hidden===false&&shell.classList.contains('browser-tabs-peek-open');
  function clear(){if(timer!==null){window.clearTimeout(timer);timer=null;}}
  const stateClass=(name,value)=>{if(shell.classList.contains(name)!==value)shell.classList.toggle(name,value);};
  function paint(enabled,open){
    stateClass('browser-tabs-peek',enabled);stateClass('browser-tabs-peek-open',enabled&&open);
    stateClass('browser-tabs-peek-pinned',enabled&&pinned);
    // 固定表示は重ねずに列として並べる（ページはその分だけ狭くなる）。ピンはどちらの形でも出す。
    stateClass('browser-tabs-pinned',eligible()&&pinned);
    pin.hidden=!eligible();pin.setAttribute('aria-pressed',String(pinned));
    pin.title=pinned?'タブの列を細くする':'タブの列を広げる';pin.setAttribute('aria-label',pin.title);const label=pin.querySelector('span');if(label)label.textContent=pinned?'細くする':'広げる';
  }
  function sync(){
    if(!eligible()){clear();hovered=false;dragging=false;paint(false,false);return;}
    if(pinned){clear();paint(false,false);return;}
    if(hovered||focused()||blocked()||retained()){clear();paint(true,true);return;}
    if(shell.classList.contains('browser-tabs-peek-open')){
      if(timer===null)timer=window.setTimeout(()=>{timer=null;if(!eligible())sync();else if(pinned||hovered||focused()||blocked()||retained())sync();else paint(true,false);},delay);
    }else paint(true,false);
  }
  const enter=()=>{hovered=true;sync();},leave=()=>{hovered=false;sync();},focus=()=>sync(),start=()=>{dragging=true;sync();},end=()=>{dragging=false;sync();};
  sidebar.addEventListener('pointerenter',enter);sidebar.addEventListener('pointerleave',leave);
  sidebar.addEventListener('focusin',focus);sidebar.addEventListener('focusout',focus);
  window.addEventListener('blur',focus);window.addEventListener('focus',focus);
  panel.addEventListener('dragstart',start);document.addEventListener('dragend',end);document.addEventListener('drop',end);
  const toggle=()=>{if(!eligible())return;pinned=!pinned;try{storage?.setItem(preference,pinned?'1':'0');}catch{}sync();};pin.addEventListener('click',toggle);
  const observer=new window.MutationObserver(sync);observer.observe(shell,{attributes:true,attributeFilter:['class']});
  if(menu)observer.observe(menu,{attributes:true,attributeFilter:['hidden']});
  wide.addEventListener('change',sync);sync();
  return{sync,destroy(){if(destroyed)return;destroyed=true;clear();observer.disconnect();wide.removeEventListener('change',sync);
    sidebar.removeEventListener('pointerenter',enter);sidebar.removeEventListener('pointerleave',leave);sidebar.removeEventListener('focusin',focus);sidebar.removeEventListener('focusout',focus);
    window.removeEventListener('blur',focus);window.removeEventListener('focus',focus);
    panel.removeEventListener('dragstart',start);document.removeEventListener('dragend',end);document.removeEventListener('drop',end);pin.removeEventListener('click',toggle);paint(false,false);}};
}
