// A rail reader owns its DOM and selection. Opening it never navigates the canvas.
export function createRailReader({document,read,open,friendlyError,onState=()=>{}}) {
  const selected=new Map();let generation=0;
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
      }catch(error){if(request!==generation||selected.get(key)!==state||!preview.isConnected)return;status.textContent=friendlyError?.(error)??String(error);const retry=node('button','再試行');retry.type='button';retry.onclick=load;status.append(retry);}
    }await load();
  }
  // 右列の「戻る」で一覧へ戻すとき：開いている詳細だけを閉じる（onState は呼ばない）。
  function close(key){const state=selected.get(key);if(!state)return;state.preview.remove();state.row.setAttribute('aria-expanded','false');selected.delete(key);}
  const isOpen=(key,row)=>selected.get(key)?.row===row;
  return {show,clear,close,isOpen};
}
