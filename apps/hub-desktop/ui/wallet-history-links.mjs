const explorers=new Map([[1,'etherscan.io'],[137,'polygonscan.com'],[80002,'amoy.polygonscan.com'],[8453,'basescan.org'],[42161,'arbiscan.io'],[10,'optimistic.etherscan.io']]);
export function walletExplorerUrl(item){
  if(!item||!Number.isSafeInteger(item.chainId)||typeof item.txHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(item.txHash)||typeof item.explorerUrl!=='string')return null;
  try{const u=new URL(item.explorerUrl);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.hostname===explorers.get(item.chainId)&&u.pathname==='/tx/'+item.txHash?u.href:null;}catch{return null;}
}
export function appendWalletHistoryLinks(document,row,item,{copy,open,isCurrent=()=>true}){
  if(typeof item.txHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(item.txHash))return;
  const actions=document.createElement('div');actions.className='actions';const state=document.createElement('span');state.className='wallet-note';state.setAttribute('role','status');
  const button=(text,run)=>{const n=document.createElement('button');n.type='button';n.className='head-action';n.textContent=text;n.onclick=async()=>{if(n.disabled||!isCurrent())return;n.disabled=true;try{await run();if(isCurrent())state.textContent=text==='取引IDをコピー'?'コピーしました':'';}catch{if(isCurrent())state.textContent='操作できませんでした。再試行してください。';}finally{if(isCurrent())n.disabled=false;}};actions.append(n);};
  button('取引IDをコピー',()=>copy(item.txHash));const url=walletExplorerUrl(item);if(url)button('取引の詳細',()=>open(url));
  actions.append(state);row.append(actions);
}
