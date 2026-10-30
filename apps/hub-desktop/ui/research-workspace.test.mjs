import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {projectCreation,projectWorkspace,documentWorkspace} from './research-workspace.mjs';
const fixture=()=>new JSDOM('<main><h3 data-research-section="文書・コード"></h3><h3 data-research-section="資料・作品・議論"></h3><pre>old</pre></main>');
const input=(form,name,value)=>{form.elements[name].value=value;form.elements[name].dispatchEvent(new form.ownerDocument.defaultView.Event('input'));};
const submit=async f=>{await f.onsubmit({preventDefault(){}});};
test('project creation stays native and preserves input after a failure',async()=>{
  const dom=fixture(),target=dom.window.document.querySelector('main'),state={},calls=[];let fail=true,opened;
  projectCreation(target,{state,invoke:async(name,args)=>{calls.push([name,args]);if(fail)throw new Error('offline');return{project:{id:'new'}};},openProject:p=>{opened=p;}});
  const f=target.querySelector('form');input(f,'title','Project');input(f,'description','研究');
  assert.equal(f.elements.visibility.value,'confidential');await submit(f);
  assert.equal(f.elements.title.value,'Project');assert.equal(state.title,'Project');assert.match(f.textContent,/offline/);
  fail=false;await submit(f);assert.equal(opened.id,'new');assert.deepEqual(state,{});
  assert.equal(calls[1][0],'hub_client_action');assert.equal(calls[1][1].action,'research_create_project');dom.window.close();
});
test('long code drafts and cursor survive a rerender while readonly viewers receive no mutation controls',async()=>{
  const dom=fixture(),target=dom.window.document.querySelector('main'),state={},calls=[];
  const data={project:{id:'rp'},canEdit:true,workspace:{documents:[],links:[]}};
  const options={state,invoke:async(name,args)=>{calls.push(args);return{};}};
  projectWorkspace(target,data,options);let f=[...target.querySelectorAll('form')].find(form=>form.elements.body);input(f,'title','Code');input(f,'body','文'.repeat(1000));f.elements.body.setSelectionRange(2,4);f.elements.body.onselect();
  target.querySelectorAll('details').forEach(n=>n.remove());projectWorkspace(target,data,options);f=[...target.querySelectorAll('form')].find(form=>form.elements.body);
  assert.equal(f.elements.body.value.length,1000);f.elements.body.focus();assert.equal(f.elements.body.selectionStart,2);await submit(f);
  assert.equal(calls[0].options.body.length,1000);assert.equal(calls[0].action,'research_create');
  target.replaceChildren();projectWorkspace(target,{...data,canEdit:false},options);assert.equal(target.querySelector('form'),null);dom.window.close();
});
test('related search ignores stale responses and keeps duplicate additions disabled',async()=>{
  const dom=fixture(),target=dom.window.document.querySelector('main');let resolveFirst,calls=0;
  projectWorkspace(target,{project:{id:'rp'},canEdit:true,workspace:{links:[{kind:'article',targetId:'a',href:'/v2/articles/a'}]}},{state:{},invoke:async()=>{calls++;if(calls===1)return await new Promise(r=>{resolveFirst=r;});return[{kind:'article',targetId:'a',title:'Added',href:'/v2/articles/a'}];}});
  const f=target.querySelector('.research-link-search');input(f,'query','old');const first=f.onsubmit({preventDefault(){}});input(f,'query','new');await f.onsubmit({preventDefault(){}});
  resolveFirst([{kind:'article',targetId:'b',title:'Stale'}]);await first;
  assert.equal(target.querySelector('.research-link-row').textContent,'Added追加済み');assert.equal(target.querySelector('.research-link-row button:last-child').disabled,true);dom.window.close();
});
test('document proposals use the original head and retain drafts on conflict',async()=>{
  const dom=fixture(),root=dom.window.document.querySelector('main'),state={};let request;
  const data={signedIn:true,document:{id:'doc',projectId:'rp',head:3},revision:{version:3,body:'initial'},history:[{version:3,summary:'latest'}]};
  documentWorkspace(root,data,{state,invoke:async(_,args)=>{request=args;throw new Error('research_propose_rejected:409:最新版を読み直してください');}});
  const f=root.querySelector('form');input(f,'body','changed');input(f,'summary','revision');await submit(f);assert.equal(request,undefined);await proposalButton(root,'確認して変更提案を保存').onclick();
  assert.equal(request.options.baseVersion,3);assert.equal(root.querySelector('textarea').value,'changed');assert.equal(state.edit.body,'changed');assert.match(root.textContent,/最新版を読み直して/);dom.window.close();
});
test('public visibility requires a separate confirmation, and text is never executed',async()=>{
  const dom=fixture(),root=dom.window.document.querySelector('main');let writes=0;
  documentWorkspace(root,{signedIn:true,canEdit:true,document:{id:'doc',projectId:'rp',head:1,visibility:'confidential'},revision:{version:1,body:'<script>run()</script>'},history:[]},{state:{},invoke:async()=>{writes++;}});
  const forms=root.querySelectorAll('form'),f=forms[1];input(f,'visibility','public');await submit(f);assert.equal(writes,0);
  f.elements.publicConfirmation.checked=true;await submit(f);assert.equal(writes,1);assert.equal(root.querySelector('script'),null);dom.window.close();
});

test('discussion entries use the visible public revision and proposal base without copying their text',()=>{
  const dom=fixture(),root=dom.window.document.querySelector('main'),opened=[];
  const options={state:{},openDiscussion:(...args)=>opened.push(args)};
  documentWorkspace(root,{canDiscuss:true,document:{id:'doc',projectId:'rp',head:5},revision:{version:2,body:'PRIVATE DRAFT'},history:[]},options);
  [...root.querySelectorAll('button')].find(n=>n.textContent==='表示中のv2について議論する').click();assert.deepEqual(opened[0],['rp','doc',2,'参照した版について議論']);
  const data={project:{id:'rp',visibility:'public'},workspace:{documents:[{id:'doc',visibility:'public'}],proposals:[{id:'proposal',documentId:'doc',baseVersion:3,body:'SECRET PROPOSAL',summary:'Do not copy',status:'open'}]}};
  root.replaceChildren();projectWorkspace(root,data,options);
  [...root.querySelectorAll('button')].find(n=>n.textContent==='元のv3について議論する').click();assert.deepEqual(opened[1],['rp','doc',3,'参照した版について議論']);
  root.replaceChildren();projectWorkspace(root,{...data,project:{id:'rp',visibility:'confidential'}},options);assert.equal([...root.querySelectorAll('button')].some(n=>n.textContent==='元のv3について議論する'),false);
  root.replaceChildren();documentWorkspace(root,{canDiscuss:false,document:{id:'doc',projectId:'rp',head:5},revision:{version:2},history:[]},options);assert.equal(root.querySelector('button'),null);dom.window.close();
});

test('proposal catalog opens comparison instead of directly deciding and preserves discussion base only',()=>{
  const dom=fixture(),root=dom.window.document.querySelector('main'),opened=[],discussions=[],calls=[];
  const data={project:{id:'rp',visibility:'public'},canEdit:true,workspace:{documents:[{id:'doc',title:'文書',visibility:'public'}],proposals:[{id:'proposal',documentId:'doc',baseVersion:3,body:'PRIVATE PROPOSED BODY',summary:'変更理由',status:'open'}]}};
  projectWorkspace(root,data,{state:{},invoke:async(...args)=>{calls.push(args);},openProposal:(...args)=>opened.push(args),openDiscussion:(...args)=>discussions.push(args)});
  [...root.querySelectorAll('button')].find(n=>n.textContent==='比較して確認').click();assert.deepEqual(opened,[['rp','proposal']]);
  assert.equal([...root.querySelectorAll('button')].some(n=>/採用して新版を作る|却下/.test(n.textContent)),false);assert.doesNotMatch(root.textContent,/PRIVATE PROPOSED BODY/);
  [...root.querySelectorAll('button')].find(n=>n.textContent==='元のv3について議論する').click();assert.deepEqual(discussions,[['rp','doc',3,'参照した版について議論']]);assert.equal(calls.length,0);dom.window.close();
});




const proposalButton=(root,label)=>[...root.querySelectorAll('button')].find(n=>n.textContent===label);
const proposalData=(version=3,head=version)=>({signedIn:true,document:{id:'doc',projectId:'rp',head,title:'文書',visibility:'public'},revision:{version,body:'初期本文'},history:[{version:head,summary:'最新版'}]});
const bodyDigest=async body=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),byte=>byte.toString(16).padStart(2,'0')).join('');
const savedProposal=async(payload,status='open')=>({proposalId:payload.requestId,documentId:payload.documentId,baseVersion:payload.baseVersion,contentHash:await bodyDigest(payload.body),status});
const proposalTick=()=>new Promise(resolve=>setTimeout(resolve,0));
const proposalDeferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function prepareProposal(root,body='  <script>本文</script>😀  ',summary='  変更の理由  '){const f=root.querySelector('.research-proposal-create form');input(f,'body',body);input(f,'summary',summary);await submit(f);}
function proposalFixture(options={},state={},data=proposalData()){
  const dom=fixture(),root=dom.window.document.querySelector('main'),calls=[];
  const controller=documentWorkspace(root,data,{state,invoke:async(name,args)=>{calls.push([name,args]);return savedProposal(args.options);},...options});return{dom,root,controller,state,calls};
}

test('proposal preview writes nothing, keeps body whitespace and hashes exact UTF8, then saves only after confirmation',async()=>{
  const view=proposalFixture();await prepareProposal(view.root);
  assert.equal(view.calls.length,0);assert.equal(view.root.querySelectorAll('script,img').length,0);assert.match(view.root.querySelector('[data-research-propose-preview-body]').textContent,/<script>本文/);
  await proposalButton(view.root,'確認して変更提案を保存').onclick();const [name,args]=view.calls[0];
  assert.equal(name,'hub_client_action');assert.equal(args.action,'research_propose');assert.equal(args.target,'rp');assert.equal(args.options.body,'  <script>本文</script>😀  ');assert.equal(args.options.summary,'変更の理由');assert.equal(args.options.baseVersion,3);assert.match(args.options.requestId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(view.state.edit.saved.contentHash,await bodyDigest(args.options.body));assert.match(view.root.textContent,/変更提案は保存済み/);assert.equal(proposalButton(view.root,'確認して変更提案を保存'),undefined);view.controller.dispose();view.dom.window.close();
});

test('unknown proposal result keeps one UUID and immutable body/base/summary across conflict, attempted edits and retry',async()=>{
  let attempts=0;const writes=[],view=proposalFixture({invoke:async(_,args)=>{writes.push(args);attempts++;if(attempts===1)throw Error('network');if(attempts===2)throw Error('research_propose_rejected:409:changed');return savedProposal(args.options);}});
  await prepareProposal(view.root,'original body','reason');await proposalButton(view.root,'確認して変更提案を保存').onclick();assert.equal(view.root.querySelector('textarea').disabled,true);assert.equal(proposalButton(view.root,'編集に戻る'),undefined);assert.equal(proposalButton(view.root,'新しい変更提案を作る'),undefined);
  input(view.root.querySelector('form'),'body','ATTEMPTED CHANGE');await proposalButton(view.root,'同じ提案の保存結果を確認する').onclick();assert.equal(view.root.querySelector('textarea').disabled,true);
  await proposalButton(view.root,'同じ提案の保存結果を確認する').onclick();assert.equal(writes.length,3);assert.deepEqual(writes[0],writes[1]);assert.deepEqual(writes[0],writes[2]);assert.match(view.root.textContent,/変更提案は保存済み/);view.controller.dispose();view.dom.window.close();
});

test('every definite first refusal preserves editable draft; edited preview gets a new UUID while base stays fixed',async()=>{
  for(const code of [400,403,404,409,429]){
    const writes=[],view=proposalFixture({invoke:async(_,args)=>{writes.push(args);if(writes.length===1)throw Error(`research_propose_rejected:${code}:確認してください`);return savedProposal(args.options);}});
    await prepareProposal(view.root,'before','reason');await proposalButton(view.root,'確認して変更提案を保存').onclick();assert.equal(view.root.querySelector('textarea').disabled,false);assert.equal(view.state.edit.body,'before');assert.equal(view.state.edit.uncertain,false);
    await prepareProposal(view.root,'after',' new reason ');await proposalButton(view.root,'確認して変更提案を保存').onclick();assert.notEqual(writes[0].options.requestId,writes[1].options.requestId);assert.equal(writes[1].options.baseVersion,3);assert.equal(writes[1].options.summary,'new reason');view.controller.dispose();view.dom.window.close();
  }
});

test('wrong result UUID, target, base, body hash and status cannot mark saved or allow a fresh operation',async()=>{
  for(const change of [value=>({...value,proposalId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}),value=>({...value,documentId:'other'}),value=>({...value,baseVersion:4}),value=>({...value,contentHash:'sha256:'+'f'.repeat(64)}),value=>({...value,contentHash:value.contentHash+'\n'}),value=>({...value,status:'unknown'})]){
    const writes=[],view=proposalFixture({invoke:async(_,args)=>{writes.push(args);return change(await savedProposal(args.options));}});await prepareProposal(view.root,'body','reason');await proposalButton(view.root,'確認して変更提案を保存').onclick();
    assert.doesNotMatch(view.root.textContent,/変更提案は保存済み/);assert.equal(view.root.querySelector('textarea').disabled,true);await proposalButton(view.root,'同じ提案の保存結果を確認する').onclick();assert.deepEqual(writes[0],writes[1]);view.controller.dispose();view.dom.window.close();
  }
});

test('returning while proposal save is pending receives the original acknowledgement without another POST',async()=>{
  const pending=proposalDeferred(),state={},old=proposalFixture({invoke:async()=>pending.promise},state);await prepareProposal(old.root,'keep body','keep reason');const review=old.state.edit.review;
  proposalButton(old.root,'確認して変更提案を保存').click();await proposalTick();const oldText=old.root.textContent;old.controller.dispose();
  const returned=proposalFixture({},state);assert.equal(proposalButton(returned.root,'同じ提案の保存結果を確認する').disabled,true);pending.resolve(await savedProposal(review.payload));await proposalTick();
  assert.match(returned.root.textContent,/変更提案は保存済み/);assert.equal(returned.calls.length,0);assert.equal(old.root.textContent,oldText);returned.controller.dispose();old.dom.window.close();returned.dom.window.close();
});

test('unexecuted preview survives return but a changed head requires an explicit rebase and fresh confirmation',async()=>{
  const state={},old=proposalFixture({},state);await prepareProposal(old.root,'old draft','reason');const payload=state.edit.review.payload;
  const text=old.root.querySelector('textarea');text.setSelectionRange(2,4);text.onselect();old.controller.dispose();
  const same=proposalFixture({},state);same.root.querySelector('textarea').focus();assert.equal(same.root.querySelector('textarea').selectionStart,2);assert.deepEqual(state.edit.review.payload,payload);assert.equal(proposalButton(same.root,'確認して変更提案を保存').disabled,false);same.controller.dispose();
  const returned=proposalFixture({},state,proposalData(4,4));assert.equal(returned.root.querySelector('textarea').value,'old draft');assert.equal(state.edit.baseVersion,3);assert.match(returned.root.textContent,/基準 v3.*最新版 v4/);
  const staleSave=proposalButton(returned.root,'確認して変更提案を保存');assert.equal(staleSave.disabled,true);await staleSave.onclick();assert.equal(returned.calls.length,0);
  proposalButton(returned.root,'表示中の最新版を基準にする').click();assert.equal(state.edit.baseVersion,4);assert.equal(state.edit.review,undefined);assert.equal(returned.root.querySelector('textarea').value,'old draft');assert.equal(returned.root.querySelector('input[name=summary]').value,'reason');
  await submit(returned.root.querySelector('form'));assert.notEqual(state.edit.review.payload.requestId,payload.requestId);assert.equal(state.edit.review.payload.baseVersion,4);assert.equal(returned.calls.length,0);
  await proposalButton(returned.root,'確認して変更提案を保存').onclick();assert.equal(returned.calls[0][1].options.baseVersion,4);returned.controller.dispose();old.dom.window.close();same.dom.window.close();returned.dom.window.close();
});

test('a historic draft keeps its inputs when opening latest, then becomes reviewable only after explicit base update',async()=>{
  const state={},opened=[],old=proposalFixture({openRevision:(...args)=>opened.push(args)},state,proposalData(2,3));await prepareProposal(old.root,'historic draft','historic reason');assert.equal(state.edit.baseVersion,2);
  proposalButton(old.root,'最新版を確認').click();assert.deepEqual(opened,[['rp','doc',3,'文書']]);old.controller.dispose();
  const latest=proposalFixture({},state,proposalData(3,3));assert.equal(state.edit.baseVersion,2);assert.equal(latest.root.querySelector('textarea').value,'historic draft');assert.equal(proposalButton(latest.root,'提案全文を確認').disabled,true);
  proposalButton(latest.root,'表示中の最新版を基準にする').click();assert.equal(latest.root.querySelector('input[name=summary]').value,'historic reason');assert.equal(proposalButton(latest.root,'提案全文を確認').disabled,false);await submit(latest.root.querySelector('form'));assert.equal(state.edit.review.payload.baseVersion,3);assert.equal(latest.calls.length,0);latest.controller.dispose();old.dom.window.close();latest.dom.window.close();
});

test('confirmed conflict permits readonly reread and an explicit latest-base update without losing the draft',async()=>{
  const state={},reads=[],pending=proposalDeferred(),old=proposalFixture({invoke:async()=>{throw Error('research_propose_rejected:409:最新版を読み直してください');},reload:()=>{reads.push('GET');return pending.promise;}},state);
  await prepareProposal(old.root,'draft before conflict','reason before conflict');const payload=state.edit.review.payload;await proposalButton(old.root,'確認して変更提案を保存').onclick();
  const reread=proposalButton(old.root,'文書を再読み込み');const reading=reread.onclick();await reread.onclick();assert.deepEqual(reads,['GET']);assert.equal(state.edit.baseVersion,3);assert.deepEqual(state.edit.review.payload,payload);pending.resolve();await reading;old.controller.dispose();
  const latest=proposalFixture({},state,proposalData(4,4));assert.equal(proposalButton(latest.root,'確認して変更提案を保存').disabled,true);proposalButton(latest.root,'表示中の最新版を基準にする').click();await submit(latest.root.querySelector('form'));
  assert.notEqual(state.edit.review.payload.requestId,payload.requestId);assert.equal(state.edit.review.payload.baseVersion,4);assert.equal(state.edit.review.payload.body,payload.body);assert.equal(state.edit.review.payload.summary,payload.summary);assert.equal(latest.calls.length,0);latest.controller.dispose();old.dom.window.close();latest.dom.window.close();
});

test('uncertain save permits readonly reread but keeps the old UUID and base across a newer head and failed reread',async()=>{
  const state={},writes=[],old=proposalFixture({invoke:async(_,args)=>{writes.push(args);throw Error('network');},reload:async()=>{throw Error('read failed');}},state);
  await prepareProposal(old.root,'fixed private body','fixed reason');const payload=state.edit.review.payload;await proposalButton(old.root,'確認して変更提案を保存').onclick();await proposalButton(old.root,'文書を再読み込み').onclick();assert.match(old.root.textContent,/再読み込みできませんでした/);assert.deepEqual(state.edit.review.payload,payload);assert.equal(state.edit.locked,true);old.controller.dispose();
  const latest=proposalFixture({invoke:async(_,args)=>{writes.push(args);return savedProposal(args.options);}},state,proposalData(4,4));assert.equal(proposalButton(latest.root,'表示中の最新版を基準にする'),undefined);assert.equal(proposalButton(latest.root,'最新版を確認'),undefined);assert.equal(latest.root.querySelector('textarea').disabled,true);
  await proposalButton(latest.root,'同じ提案の保存結果を確認する').onclick();assert.deepEqual(writes[0],writes[1]);assert.equal(writes[1].options.baseVersion,3);assert.match(latest.root.textContent,/変更提案は保存済み/);latest.controller.dispose();old.dom.window.close();latest.dom.window.close();
});

test('failed navigation and stale rerenders keep the saved receipt and never resend; explicit reset creates a fresh UUID',async()=>{
  const state={},opened=[],view=proposalFixture({openProposal:async(...args)=>{opened.push(args);throw Error('navigation read failed');}},state);await prepareProposal(view.root,'private body','PRIVATE_REASON');await proposalButton(view.root,'確認して変更提案を保存').onclick();const oldId=state.edit.saved.proposalId;
  await proposalButton(view.root,'保存した変更提案を開く').onclick();assert.deepEqual(opened,[['rp',oldId]]);assert.match(view.root.textContent,/保存済み.*比較詳細を開けません/);assert.equal(view.calls.length,1);view.controller.dispose();
  const returned=proposalFixture({},state,proposalData(4,4));assert.match(returned.root.textContent,/変更提案は保存済み/);assert.equal(returned.calls.length,0);proposalButton(returned.root,'新しい変更提案を作る').click();await prepareProposal(returned.root,'new body','new reason');assert.equal(returned.calls.length,0);assert.equal(state.edit.review.payload.baseVersion,4);assert.notEqual(state.edit.review.payload.requestId,oldId);
  await proposalButton(returned.root,'確認して変更提案を保存').onclick();assert.equal(returned.calls.length,1);returned.controller.dispose();view.dom.window.close();returned.dom.window.close();
});

test('account change clears proposal input and ignores an old save acknowledgement even after ordinary disposal',async()=>{
  const pending=proposalDeferred(),state={document:{title:'OTHER_DRAFT'},gitDiscussions:{pin:{requestId:'OTHER_UUID'}}},view=proposalFixture({invoke:async()=>pending.promise},state);await prepareProposal(view.root,'OLD_PRIVATE_BODY','OLD_PRIVATE_REASON');const payload=state.edit.review.payload;
  proposalButton(view.root,'確認して変更提案を保存').click();await proposalTick();view.controller.dispose();const detachedText=view.root.textContent;view.dom.window.dispatchEvent(new view.dom.window.Event('hub-account-changed'));
  pending.resolve(await savedProposal(payload));await proposalTick();assert.deepEqual(state.proposalSubmissions,{});assert.equal(state.edit,undefined);assert.equal(state.document.title,'OTHER_DRAFT');assert.equal(state.gitDiscussions.pin.requestId,'OTHER_UUID');assert.equal(view.root.textContent,detachedText);
  const current=proposalFixture({},state);assert.equal(current.root.querySelector('textarea').value,'初期本文');assert.equal(proposalButton(current.root,'同じ提案の保存結果を確認する'),undefined);current.controller.invalidate();assert.equal(current.root.querySelector('pre'),null);current.controller.dispose();current.dom.window.close();view.dom.window.close();
});

test('account-bound invoke rejection clears old operation state without interpreting it as an uncertain save',async()=>{
  const view=proposalFixture({invoke:async()=>{throw Error('接続が変わりました。画面を読み直してください。');}});await prepareProposal(view.root,'old body','reason');await proposalButton(view.root,'確認して変更提案を保存').onclick();assert.deepEqual(view.state.proposalSubmissions,{});assert.equal(view.state.edit,undefined);assert.doesNotMatch(view.root.textContent,/old body|保存済み/);view.controller.dispose();view.dom.window.close();
});

test('body bounds, blank text, malformed UTF16 and historic revisions cannot reach proposal execution',async()=>{
  for(const [body,summary] of [['   ','reason'],['body','   '],['x'.repeat(100001),'reason'],['body','x'.repeat(501)],['\ud800','reason'],['body','\udfff']]){const view=proposalFixture();await prepareProposal(view.root,body,summary);assert.equal(proposalButton(view.root,'確認して変更提案を保存').hidden,true);assert.equal(view.calls.length,0);view.controller.dispose();view.dom.window.close();}
  const readonly=proposalFixture({}, {},proposalData(2,3));await prepareProposal(readonly.root,'old','reason');assert.equal(readonly.calls.length,0);assert.equal(proposalButton(readonly.root,'提案全文を確認').disabled,true);assert.match(readonly.root.textContent,/過去の版/);readonly.controller.dispose();readonly.dom.window.close();
  const view=proposalFixture();await prepareProposal(view.root,'😀'.repeat(50000),'境界');assert.equal(view.state.edit.review.payload.body.length,100000);await proposalButton(view.root,'確認して変更提案を保存').onclick();assert.match(view.root.textContent,/変更提案は保存済み/);view.controller.dispose();view.dom.window.close();
});

