import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {communityGuideEditor} from './community-guide-editor.mjs';
import {communityGuideCatalog,communityGuidePage,communityGuideProposal,communityGuideRequest} from './community-guide-reader.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const button=(root,label)=>[...root.querySelectorAll('button')].find(item=>item.textContent===label);
const field=(dom,root,label,value)=>{const input=root.querySelector('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new dom.window.Event('input'));};
const preview=(dom,root)=>root.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
test('proposal confirmation sends nothing; lost responses retain the draft and request ID, then matching acknowledgement opens the saved proposal',async()=>{
 const dom=new JSDOM(''),state={},calls=[],saved=[];let fail=true,release;
 const root=communityGuideEditor(dom.window.document,{communityId:'c1',page:{id:'g1',title:'Guide',body:'Old body',version:4},state,onSaved:item=>saved.push(item),invoke:async(_,p)=>{calls.push(p);if(fail){await new Promise(resolve=>release=resolve);throw Error('lost response');}return {proposal:{id:p.requestId,communityId:'c1'}};}});
 field(dom,root,'本文','New body');field(dom,root,'変更の説明','Confirm the sources.');preview(dom,root);assert.equal(calls.length,0);assert.match(root.textContent,/元の版: v4/);
 button(root,'この内容で提案').click();button(root,'この内容で提案').click();assert.equal(calls.length,1);release();await tick();assert.equal(state.proposedBody,'New body');assert.match(root.textContent,/lost response/);assert.equal(saved.length,0);
 fail=false;button(root,'この内容で提案').click();await tick();assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[1].options.baseVersion,4);assert.equal(calls[1].text,'New body');assert.equal(saved.length,1);assert.deepEqual(state,{});assert.equal(root.querySelector('[aria-label="本文"]').value,'');dom.window.close();
});
test('wrong acknowledgements retain input and editing a confirmed field requires confirmation again',async()=>{
 const dom=new JSDOM(''),state={},calls=[];const root=communityGuideEditor(dom.window.document,{communityId:'c1',state,invoke:async(_,p)=>{calls.push(p);return{proposal:{id:p.requestId,communityId:'other'}};}});
 for(const [label,value] of [['タイトル','Title'],['本文','Body'],['変更の説明','Change']])field(dom,root,label,value);
 preview(dom,root);button(root,'この内容で提案').click();await tick();assert.match(root.textContent,/保存結果を確認できません/);assert.equal(state.proposedBody,'Body');
 field(dom,root,'本文','Different');button(root,'この内容で提案').click();await tick();assert.equal(calls.length,1);preview(dom,root);button(root,'この内容で提案').click();await tick();assert.equal(calls.length,2);assert.notEqual(calls[0].requestId,calls[1].requestId);dom.window.close();
});
test('UTF-16 field boundaries and Unicode proposal titles are preserved without executing preview HTML',async()=>{
 const dom=new JSDOM(''),calls=[];const root=communityGuideEditor(dom.window.document,{communityId:'c1',invoke:async(_,p)=>{calls.push(p);return{proposal:{id:p.requestId,communityId:'c1'}};}});
 field(dom,root,'タイトル','😀'.repeat(60));field(dom,root,'本文','<img src=x onerror=alert(1)>');field(dom,root,'変更の説明','😀'.repeat(250));preview(dom,root);assert.equal(root.querySelector('img'),null);button(root,'この内容で提案').click();await tick();assert.equal(calls[0].options.title,'😀'.repeat(60));
 field(dom,root,'タイトル','Too long');field(dom,root,'本文','😀'.repeat(15001));field(dom,root,'変更の説明','Note');preview(dom,root);assert.match(root.textContent,/文字数/);assert.equal(calls.length,1);dom.window.close();
});
test('a restored draft keeps its original page version and a saved proposal is not resubmitted when navigation fails',async()=>{
 const dom=new JSDOM(''),state={baseVersion:1,proposedBody:'Old draft',summary:'Change',proposedTitle:'Title'},calls=[];
 const root=communityGuideEditor(dom.window.document,{communityId:'c1',page:{id:'g1',title:'New page',body:'New version',version:2},state,onSaved:()=>{throw Error('failed navigation');},invoke:async(_,p)=>{calls.push(p);return{proposal:{id:p.requestId,communityId:'c1'}};}});
 preview(dom,root);assert.match(root.textContent,/元の版: v1/);button(root,'この内容で提案').click();await tick();assert.equal(calls[0].options.baseVersion,1);assert.equal(calls[0].text,'Old draft');assert.match(root.textContent,/保存済み/);assert.deepEqual(state,{});button(root,'この内容で提案').click();await tick();assert.equal(calls.length,1);dom.window.close();
});
test('catalogue and page entry points obey writer permissions and proposal lists keep metadata paging and history',async()=>{
 const dom=new JSDOM(''),opens=[],doc=dom.window.document;
 const data={pages:[],directories:[{id:'d1',name:'Directory'}],directoryId:'d1',canPropose:true,page:{offset:0,hasMore:false,nextOffset:null}};
 const catalog=communityGuideCatalog(doc,{communityId:'c1',data,invoke:async()=>{},onOpen:(...args)=>opens.push(args)});button(catalog,'編集案の一覧').click();assert.deepEqual(opens[0],['community_guide_proposals',['c1'],'編集案']);button(catalog,'新しいガイドを提案').click();assert.ok(catalog.querySelector('form'));assert.equal(catalog.querySelector('form select').value,'d1');
 const readOnly=communityGuidePage(doc,{communityId:'c1',pageId:'g1',data:{page:{id:'g1',title:'Guide',body:'Body',version:1},canPropose:false},onOpen:()=>{}});assert.equal(button(readOnly,'編集案を作る'),undefined);
 const list=communityGuideCatalog(doc,{communityId:'c1',proposals:true,data:{proposals:[{id:'p1',title:'Proposal',summary:'Why',status:'changes_requested'}],page:{offset:20,hasMore:false,nextOffset:null}},onOpen:(...args)=>opens.push(args)});button(list,'Proposal').click();assert.deepEqual(opens[1],['community_guide_proposal',['c1','p1'],'Proposal']);assert.match(list.textContent,/修正依頼/);assert.deepEqual(communityGuideRequest({name:'community_guide_proposals',ids:['c1'],guidePage:{offset:20}}),{name:'community_guide_proposals_page',ids:['c1','20']});
 const proposal=communityGuideProposal(doc,{data:{proposal:{title:'Proposal',summary:'Why',proposedTitle:'Guide',proposedBody:'<script>unsafe()</script>',status:'open',baseVersion:1}}});assert.equal(proposal.querySelector('script'),null);assert.match(proposal.textContent,/レビュー待ち/);dom.window.close();
});

test('proposal classification is confirmed explicitly, retained on retry, and changes invalidate the previous confirmation',async()=>{
 const dom=new JSDOM(''),state={},calls=[];let fail=true;
 const root=communityGuideEditor(dom.window.document,{communityId:'c1',page:{id:'g1',title:'Guide',body:'Body',version:2,directoryId:'a'},directories:[{id:'a',name:'First'},{id:'b',name:'Second',parentId:'a'}],state,invoke:async(_,p)=>{calls.push(p);if(fail)throw Error('offline');return {proposal:{id:p.requestId,communityId:'c1'}};}});
 field(dom,root,'変更の説明','Reclassify');const select=root.querySelector('select');assert.equal(select.value,'a');
 select.value='b';select.dispatchEvent(new dom.window.Event('change'));preview(dom,root);assert.match(root.textContent,/分類: First \/ Second/);assert.equal(calls.length,0);
 button(root,'この内容で提案').click();await tick();assert.equal(state.proposedDirectoryId,'b');assert.equal(calls[0].options.proposedDirectoryId,'b');
 fail=false;button(root,'この内容で提案').click();await tick();assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(select.value,'');
 dom.window.close();
 const restored=new JSDOM(''),draft={proposedTitle:'Guide',proposedBody:'Body',summary:'Why',proposedDirectoryId:'deleted'};
 const editor=communityGuideEditor(restored.window.document,{communityId:'c1',state:draft,directories:[{id:'a',name:'First'}],invoke:async()=>assert.fail('must not send')});
 preview(restored,editor);assert.match(editor.textContent,/分類を選び直して/);const choice=editor.querySelector('select');choice.value='a';choice.dispatchEvent(new restored.window.Event('change'));preview(restored,editor);assert.match(editor.textContent,/分類: First/);
 choice.value='';choice.dispatchEvent(new restored.window.Event('change'));button(editor,'この内容で提案').click();assert.equal(editor.querySelector('section').hidden,true);restored.window.close();
});
