// A rail reader owns its DOM and selection. Opening it never navigates the canvas.
// replyThread({threadId,text,thread}) を渡すと、スレッドを開いたとき下に返信欄が付く（中央のスレッド返信と同じ送信）。下書きはスレッドごとにメモリだけ。
export function createRailReader({document,read,open,friendlyError,onState=()=>{},replyThread,icon}) {
  const selected=new Map(),replyDrafts=new Map();let generation=0;
  const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text??'';return n;};
  function clear(){generation++;for(const state of selected.values()){state.row.setAttribute('aria-expanded','false');state.preview.remove();}selected.clear();}
  async function show(key,row,item){
    const previous=selected.get(key);
    if(previous?.row===row){previous.preview.remove();row.setAttribute('aria-expanded','false');selected.delete(key);onState(key,false);return;}
    if(previous){previous.preview.remove();previous.row.setAttribute('aria-expanded','false');}
    const preview=node('section');preview.className='rail-post-preview';
    const title=node('strong',item.title),body=node('div',item.body),status=node('p');body.className='rail-reader-body';status.className='meta';status.setAttribute('role','status');
    const controls=node('div');controls.className='rail-post-preview-actions';
    const central=node('button','中央で開く'),close=node('button','閉じる');central.type=close.type='button';central.onclick=()=>open(item);
    close.onclick=()=>{preview.remove();row.setAttribute('aria-expanded','false');selected.delete(key);onState(key,false);row.focus();};controls.append(central,close);preview.append(title,body,status,controls);row.after(preview);row.setAttribute('aria-expanded','true');
    const state={row,preview},request=generation;selected.set(key,state);onState(key,true,row,item);
    if(!item.detail)return;
    async function load(){status.replaceChildren();status.textContent='読み込み中…';
      try{const data=await read(item.detail);if(request!==generation||selected.get(key)!==state||!preview.isConnected)return;
        const content=data.article??data.post??data.thread??data.community??data.project??data;
        title.textContent=content.title??content.name??item.title;
        body.textContent=content.bodyMarkdown??content.body??content.description??content.summary??item.body??'';
        if(Array.isArray(data.posts)){const messages=node('div');for(const post of data.posts.slice(0,20)){const p=node('p',post.body??post.content??'');messages.append(p);}body.append(messages);}
        status.textContent='';
        preview.querySelector('.rail-reply')?.remove();
        if(item.detail?.name==='thread'&&typeof replyThread==='function'&&data.thread&&data.thread.status!=='closed')controls.before(replyForm(item.detail.ids?.[0]??data.thread.id,data.thread,()=>request===generation&&selected.get(key)===state&&preview.isConnected,load));
      }catch(error){if(request!==generation||selected.get(key)!==state||!preview.isConnected)return;status.textContent=friendlyError?.(error)??String(error);const retry=node('button','再試行');retry.type='button';retry.onclick=load;status.append(retry);}
    }await load();
  }
  function replyForm(threadId,thread,alive,reload){
    const form=node('form');form.className='rail-reply rail-chat-compose';
    const row=node('div');row.className='rail-chat-compose-row';
    const input=node('textarea');input.rows=1;input.maxLength=2000;input.placeholder='返信を書く';input.setAttribute('aria-label','返信（Enterで送信、Shift+Enterで改行）');input.value=replyDrafts.get(threadId)??'';
    const send=node('button');send.type='submit';send.className='approve rail-chat-send';send.setAttribute('aria-label','返信を送信');send.title='返信を送信';
    send.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12V3.5M3.5 8 8 3.5 12.5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const note=node('p');note.className='meta rail-chat-compose-note';note.setAttribute('role','status');
    let sending=false;const paint=()=>{send.disabled=sending||!input.value.trim();};
    input.addEventListener('input',()=>{replyDrafts.set(threadId,input.value);paint();});
    input.addEventListener('keydown',event=>{if(event.key!=='Enter'||event.shiftKey||event.isComposing||event.keyCode===229)return;event.preventDefault();if(!send.disabled)form.requestSubmit?form.requestSubmit():form.dispatchEvent(new document.defaultView.Event('submit',{cancelable:true}));});
    form.onsubmit=async event=>{
      event.preventDefault();const text=input.value.trim();if(!text||sending)return;
      sending=true;input.disabled=true;paint();note.textContent='送信中…';
      try{await replyThread({threadId,text,thread});replyDrafts.delete(threadId);if(!alive())return;input.value='';note.textContent='';await reload();}
      catch(error){if(alive())note.textContent=friendlyError?.(error)??String(error);}
      finally{sending=false;input.disabled=false;paint();}
    };
    row.append(input,send);form.append(row,note);paint();return form;
  }
  // 右列の「戻る」で一覧へ戻すとき：開いている詳細だけを閉じる（onState は呼ばない）。
  function close(key){const state=selected.get(key);if(!state)return;state.preview.remove();state.row.setAttribute('aria-expanded','false');selected.delete(key);}
  const isOpen=(key,row)=>selected.get(key)?.row===row;
  return {show,clear,close,isOpen};
}
