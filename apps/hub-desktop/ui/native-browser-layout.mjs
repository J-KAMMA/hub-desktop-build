// Only geometry and the resolved Hub palette cross the main-window boundary.
export function initNativeBrowserLayout({document,window,invoke,isActive,getView}) {
  const group=document.querySelector('#browser-navigation');
  if(!group||!window.ResizeObserver||!window.MutationObserver||!window.requestAnimationFrame)return {schedule:()=>{}};
  let busy=false,dirty=false,frame=null,last=null;
  const rgb=token=>{
    const probe=document.createElement('span');probe.style.color=`var(${token})`;group.append(probe);
    const value=window.getComputedStyle(probe).color;probe.remove();
    const m=value.match(/^rgba?\(([^)]+)\)$/);if(!m)return null;
    const numbers=m[1].split(/[\s,\/]+/).map(Number);
    return (numbers.length===3||numbers.length===4&&numbers[3]===1)&&numbers.slice(0,3).every(n=>Number.isFinite(n)&&n>=0&&n<=255)?numbers.slice(0,3).map(Math.round):null;
  };
  const collect=()=>{
    if(!isActive()||getView()!=='browser'||document.querySelector('dialog[open]')||group.contains(document.activeElement))return {rect:null,palette:null,fontSize:13};
    const r=group.getBoundingClientRect(),s=window.getComputedStyle(group);
    if(s.display==='none'||s.visibility!=='visible'||r.width<240||r.height<32||r.height>48||r.left<0||r.top<0||r.right>window.innerWidth||r.bottom>window.innerHeight)return {rect:null,palette:null,fontSize:13};
    const palette=Object.fromEntries(Object.entries({panel:'--panel',surface:'--surface-sunken',text:'--text',muted:'--muted',line:'--line',focus:'--focus-ring'}).map(([name,token])=>[name,rgb(token)]));
    return Object.values(palette).some(v=>!v)?{rect:null,palette:null,fontSize:13}:{rect:{x:r.x,y:r.y,w:r.width,h:r.height},palette,fontSize:13};
  };
  async function flush(){
    if(busy||!dirty)return;dirty=false;const args=collect(),key=JSON.stringify(args);if(key===last)return;
    busy=true;try{await invoke('native_browser_chrome_layout',args);last=key;}catch{group.classList.remove('native-backed');last=null;}finally{busy=false;if(dirty)schedule();}
  }
  const schedule=()=>{dirty=true;if(frame!==null)return;frame=window.requestAnimationFrame(()=>{frame=null;void flush();});};
  new window.ResizeObserver(schedule).observe(group);
  new window.MutationObserver(schedule).observe(document.querySelector('.app-shell'),{attributes:true,attributeFilter:['class','hidden']});
  new window.MutationObserver(schedule).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  for(const event of ['resize','focusin','focusout'])window.addEventListener(event,schedule);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',schedule);
  schedule();return {schedule};
}
