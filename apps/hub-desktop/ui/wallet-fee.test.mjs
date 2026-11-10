import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {ACCOUNT_UNAVAILABLE_TEXT,isAccountUnavailable} from './account-error.mjs';
const source=(await readFile(new URL('./app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const extract=(from,to)=>{const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start);return source.slice(start,end);};
const calls=[];
const ctx=vm.createContext({Error,ACCOUNT_UNAVAILABLE_TEXT,isAccountUnavailable,markAccountFault:()=>{},invoke:(...args)=>{calls.push(args);throw Error('unexpected IPC');},wallet_confirm_respond:()=>{throw Error('unexpected approval');},wallet_send_contract:()=>{throw Error('unexpected signing');}});
vm.runInContext(extract('function shopPaymentError(error) {','function renderCartReview()')+extract('const ERROR_TEXT = {','function setBadge('),ctx);
const format=(name,error)=>{ctx.input=error;return vm.runInContext(`${name}(input)`,ctx);};
const codes=['wallet_fee_unavailable','wallet_fee_expired','wallet_fee_stale'];
const messages=[
 '安全な手数料の見積もりを確認できませんでした。署名・送金は行われていません。接続状態を確認し、再度操作して新しい見積もりを確認してください。',
 '手数料の見積もりの期限が過ぎました。署名・送金は行われていません。再度操作して新しい見積もりを確認してください。',
 '送信元または取引の順序が変わりました。署名・送金は行われていません。ウォレットの状態を確認し、再度操作して新しい見積もりを確認してください。',
];
const shopFallback='支払いの結果を確認できません。再送せず、注文の状態を確認してください。';
for(const name of ['shopPaymentError','friendlyError'])test(`${name}: exact three reserved primitive and Error codes require a new explicit estimate`,()=>{
 for(const [index,code]of codes.entries())for(const error of [code,new Error(code)]){const output=format(name,error);assert.equal(output,messages[index]);assert.match(output,/署名・送金は行われていません/);assert.match(output,/再度操作して新しい見積もりを確認/);assert.doesNotMatch(output,/wallet_fee_|自動/);}
});
test('lookalike primitive codes preserve fallback without making presign guarantees',()=>{
 for(const code of codes)for(const input of [` ${code}`,`${code} `,`prefix:${code}`,`${code}:untrusted😀<img>`,code.toUpperCase(),code.replace('wallet','waIlet')]){
  assert.equal(format('shopPaymentError',input),shopFallback);assert.equal(format('friendlyError',input),input);assert.doesNotMatch(format('shopPaymentError',input),/untrusted|<img>|行われていません/);assert.doesNotMatch(format('friendlyError',input),/行われていません/);
 }
});
test('non-Error objects, arrays, boxed strings and nonstring messages are not reserved errors',()=>{
 for(const code of codes){const strangeError=new Error('unknown');strangeError.message={toString:()=>code};for(const input of [{message:code},{toString:()=>code},[code],new String(code),strangeError]){
  assert.equal(format('shopPaymentError',input),shopFallback);assert.equal(format('friendlyError',input),input===strangeError?'読み込めませんでした。時間をおいて再試行してください。':String(input));assert.doesNotMatch(format('friendlyError',input),/行われていません/);
 }}
 for(const input of [null,undefined,0,false]){assert.equal(format('shopPaymentError',input),shopFallback);assert.equal(format('friendlyError',input),String(input));}
});
test('prior wallet consent messages and unrelated native fallback behavior remain intact',()=>{
 assert.match(format('shopPaymentError','wallet_confirm_busy'),/完了してから/);assert.match(format('shopPaymentError',new Error('wallet_user_rejected')),/取り消しました/);
 assert.equal(format('friendlyError','wallet_user_rejected'),'操作をキャンセルしました');assert.equal(format('friendlyError','wallet_params_invalid'),'指定が正しくありません');assert.equal(format('friendlyError','rpc:failure'),'チェーン側が受け付けませんでした（failure）');assert.equal(format('friendlyError',new Error('other')),'other');
});
test('all actual formatters produce text only and never respond, sign, send or retry',()=>{
 for(const name of ['shopPaymentError','friendlyError'])for(const code of codes)for(const input of [code,new Error(code),`${code}:unknown`])assert.equal(typeof format(name,input),'string');assert.deepEqual(calls,[]);
});
