export function createThreadReplyTarget(document,{draft,textarea}) {
  const root=document.createElement('div');root.className='detail-form-row';
  const label=document.createElement('span');label.className='meta';
  const clear=document.createElement('button');clear.type='button';clear.className='head-action';clear.textContent='返信先を解除';
  const render=()=>{root.hidden=!draft.replyToPostId;label.textContent=draft.replyToPostId?'返信先: #'+draft.replyToPostNo:'';};
  clear.onclick=()=>{delete draft.replyToPostId;delete draft.replyToPostNo;render();};root.append(label,clear);render();
  return {root,quote(post){if(!post||typeof post.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(post.id)||!Number.isSafeInteger(post.no)||post.no<1)return;
    draft.replyToPostId=post.id;draft.replyToPostNo=post.no;
    textarea.value=(textarea.value+(textarea.value?'\n':'')+'>>'+post.no+'\n> '+String(post.body??'').replace(/\n/g,'\n> ')+'\n').slice(0,textarea.maxLength);
    textarea.dispatchEvent(new document.defaultView.Event('input'));render();textarea.focus();
  }};
}
