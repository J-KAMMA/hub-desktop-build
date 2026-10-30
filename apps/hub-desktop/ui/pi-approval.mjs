import {missingFilePreview} from './pi-work.mjs';
import {purchaseProposal} from './ai-purchase-handoff.mjs';

export function renderPiApproval({document,run,action,busy=false,onDecide,position=null}) {
  const runId=run.id,actionId=action.id,missing=missingFilePreview(action);
  const node=(tag,text,className='')=>{const value=document.createElement(tag);value.className=className;if(text!=null)value.textContent=text;return value;};
  const root=node('div',null,'piw-approval'),text=node('div',null,'piw-approval-text'),body=node('div',null,'piw-approval-body'),strip=node('div',null,'piw-approval-strip');
  if(['hub_exec','hub_http'].includes(action.tool))root.dataset.kind='command';
  strip.append(node('span',`● 承認が必要です · ${action.tool??'tool'}`,'piw-approval-label'));
  if(position&&position.total>1) {
    const nav=node('span',null,'piw-approval-nav');nav.append(node('span',`承認待ち ${position.index+1}/${position.total}`,'piw-approval-count'));
    for(const [label,step] of [['前へ',-1],['次へ',1]]) {
      const button=node('button',label,'ghost');button.type='button';button.disabled=position.index+step<0||position.index+step>=position.total;
      button.onclick=()=>{if(!button.disabled)position.onNav?.(step);};nav.append(button);
    }
    strip.append(nav);
  }
  text.append(node('strong',action.summary??'操作の承認待ち'),node('span',`ツール: ${action.tool??'tool'} · モデル: ${run.model??''}`,'meta'),node('span',`作業フォルダ: ${run.workspace??''}`,'meta'));
  if(missing)text.append(node('p','変更内容が届いていないため承認できません。Desktop Runtimeを更新してください。'));
  else if(['hub_write','hub_edit'].includes(action.tool)) {
    const preview=node('details');preview.dataset.detailKey=`approval:${actionId}`;preview.open=true;preview.append(node('summary',action.detail.path));
    for(const [label,value] of [['変更前',action.detail.before],['変更後',action.detail.after]]) {
      const content=node('pre',value,'dev-output');content.setAttribute('aria-label',`承認する変更の${label}`);preview.append(node('p',label),content);
    }
    text.append(preview);
  }
  const pay=action.tool==='hub_pay';
  if(pay) {
    const proposal=purchaseProposal(action),note=String(action.summary??'').split(' — ').slice(1).join(' — ');
    const facts=node('dl',null,'piw-purchase');
    for(const [label,value] of [['商品ID',proposal?.productId],['数量',proposal&&String(proposal.quantity)],['AIのメモ',note],['商品名',typeof action.detail?.title==='string'?action.detail.title:''],['価格',typeof action.detail?.price==='string'?action.detail.price:'']])
      if(value)facts.append(node('dt',label),node('dd',value));
    text.append(facts,node('p',proposal?'これは購入の提案です。購入画面を開くだけで、支払いや署名は行いません。内容を確認して、購入するかどうかはご自身で決めます。':'購入提案の内容が正しくないため、開けません。拒否してください。','meta'));
  }
  const actions=node('div',null,'actions');
  for(const [label,approve] of [['拒否',false],[pay?'購入画面を開く':'承認',true]]) {
    const button=node('button',label,approve?'approve':'deny');button.type='button';button.disabled=Boolean(busy)||(approve&&(missing||(pay&&!purchaseProposal(action))));
    button.onclick=()=>{if(!button.disabled)return onDecide(runId,actionId,approve);};actions.append(button);
  }
  body.append(text);root.append(strip,body,actions);return root;
}
