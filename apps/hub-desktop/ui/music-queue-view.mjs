// 2026-10-18：行に小さな表紙とアーティストを足す（YouTube Music・Spotify の再生待ちと同じ）。表紙は art(track) が作る（Hub に上げた絵だけ）。
export function initMusicQueueView({document,host,toggle,getState,onPlay,onRemove,onLayout=()=>{},art=null}) {
  let disposed=false,revision=0;
  const live=()=>!disposed&&host.isConnected&&toggle.isConnected;
  const node=(tag,text)=>{const result=document.createElement(tag);if(text!==undefined)result.textContent=text;return result;};
  const button=(label,action)=>{const result=node('button',label);result.type='button';result.className='head-action';result.onclick=action;return result;};
  function render() {
    if(!live())return;
    const turn=++revision,state=getState(),queue=state.queue,ids=queue.map(track=>track.id);
    toggle.disabled=!queue.length;toggle.setAttribute('aria-expanded',String(!host.hidden));
    const heading=node('header'),title=node('h3',`再生待ち · ${queue.length}曲`),close=button('閉じる',()=>{host.hidden=true;toggle.setAttribute('aria-expanded','false');onLayout();toggle.focus();});
    heading.append(title,close);
    const status=node('p');status.className='meta';status.setAttribute('role','status');
    const list=node('ol');list.className='music-queue-list';
    const current=()=>live()&&!host.hidden&&!toggle.closest('[hidden]')&&turn===revision&&JSON.stringify(getState().queue.map(track=>track.id))===JSON.stringify(ids)&&getState().currentId===state.currentId;
    const run=async(action)=>{if(!current())return;try{await action();}catch{if(current())status.textContent='再生待ちの操作を完了できませんでした。';}};
    for(const [index,track] of queue.entries()) {
      const row=node('li'),play=button(`${index+1}. ${track.title||'楽曲'}`,()=>run(()=>onPlay(track)));
      play.className='music-queue-track';
      if(track.artist){const by=node('small',track.artist);by.className='music-queue-artist';play.append(by);}play.setAttribute('aria-label',`${track.title||'楽曲'}を再生`);
      if(track.id===state.currentId){row.setAttribute('aria-current','true');const marker=node('span','現在の曲');marker.className='meta';row.append(marker);}
      if(typeof art==='function'){try{const cover=art(track);if(cover){cover.classList.add('music-queue-art');row.append(cover);}}catch{/* 表紙が作れなくても行は出す */}}
      row.append(play);
      if(index>state.currentIndex){const remove=button('除去',()=>run(()=>onRemove(track.id)));remove.setAttribute('aria-label',`${track.title||'楽曲'}を再生待ちから除去`);row.append(remove);}
      list.append(row);
    }
    if(!queue.length)status.textContent='再生待ちは空です。曲の「次に再生」から追加できます。';
    host.replaceChildren(heading,status,list);onLayout();
  }
  const open=()=>{if(!live())return;host.hidden=!host.hidden;render();if(!host.hidden)host.querySelector('button')?.focus();};
  toggle.addEventListener('click',open);
  const escape=event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!host.hidden&&host.contains(document.activeElement)){event.preventDefault();host.hidden=true;toggle.setAttribute('aria-expanded','false');onLayout();toggle.focus();}};
  host.addEventListener('keydown',escape);render();
  return {render,destroy(){disposed=true;++revision;toggle.removeEventListener('click',open);host.removeEventListener('keydown',escape);host.replaceChildren();host.hidden=true;onLayout();}};
}
