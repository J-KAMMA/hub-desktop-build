// Bounded recovery for reads only. Callers never pass a posting/payment/mutation operation.
const transient=new Set(['network_unavailable','network_timeout','service_unavailable','request_timeout','account_service_unavailable','desktop_account_network_unavailable','ハブが応答しません','ハブへ接続できません','ハブへ届きません','Hubに接続できません','一覧を受信できません']);
export function isTransientReadError(error){const message=String(error?.message??error);return transient.has(message)||/^ハブが (502|503|504) を返しています$/.test(message);}
export function isReadAccessDenied(error){const message=String(error?.message??error);return message.includes('desktop_not_connected')||['account_required','account_changed','desktop_account_signed_out','desktop_account_not_registered','desktop_account_unauthorized','このアカウントは停止されているか、権限がありません'].includes(message);}
export function readWaitText(error){
  const message=String(error?.message??error);
  return ['network_timeout','request_timeout','ハブが応答しません'].includes(message)
    ?'Hubの応答を待っています。初回の準備に時間がかかる場合があります。自動で再取得します。'
    :message==='service_unavailable'||/^ハブが (502|503|504) を返しています$/.test(message)
      ?'Hubが応答できるまで待っています。自動で再取得します。'
      :'Hubに接続できません。自動で再接続を試します。';
}
export function createReadRecovery({retry,active=()=>true}) {
  let timer,attempt=0,generation=0;
  const reset=()=>{clearTimeout(timer);timer=undefined;attempt=0;generation++;};
  return {reset,schedule(error){
    if(!isTransientReadError(error))return false;
    if(timer!==undefined)return true;
    if(attempt>=3||!active())return false;
    const token=generation;
    timer=setTimeout(()=>{timer=undefined;void Promise.resolve().then(()=>{if(token===generation&&active())return retry();}).catch(()=>{});},[1000,3000,8000][attempt++]);
    timer.unref?.();return true;
  }};
}
