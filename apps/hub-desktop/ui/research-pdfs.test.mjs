import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchPdfs,researchPdfList,MAX_RESEARCH_PDF_BYTES} from './research-pdfs.mjs';
const projectId='rp_project',id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const pdf={id,title:'論文',seriesId:id,version:1,visibility:'confidential',scanStatus:'pending',size:20,sha256:'a'.repeat(64),createdAt:'2026-10-06T00:00:00.000Z'};
const list=(pdfs=[pdf],canEdit=true)=>({projectId,pdfs,canEdit,signedIn:canEdit});
function fixture(t,{data=list(),state={},...options}={}){
  const dom=new JSDOM('<main></main>',{url:'http://localhost'}),target=dom.window.document.querySelector('main'),f={dom,target,state,data:structuredClone(data),calls:[],uploads:[],downloads:[]};
  f.respond=async(name,args)=>{
    if(name==='hub_detail')return f.data;
    const result={id:args.options.id,...(args.action==='research_pdf_scan'?{scanStatus:'clean'}:{visibility:args.options.visibility})};f.data.pdfs=f.data.pdfs.map(pdf=>pdf.id===result.id?{...pdf,...result}:pdf);return result;
  };
  f.uploadResult=async args=>{f.data.pdfs.push({...pdf,id:other,seriesId:args.seriesId??other,title:args.title||'picked.pdf'});return {id:other,version:1,scanStatus:'pending'};};
  f.settings={state,prepared:f.data,invoke:async(name,args)=>{f.calls.push([name,args]);return f.respond(name,args);},uploadPdf:async args=>{f.uploads.push(args);return f.uploadResult(args);},downloadPdf:async args=>{f.downloads.push(args);return {saved:true};},...options};
  f.controller=researchPdfs(target,{projectId},f.settings);f.root=f.controller.root;t.after(()=>{f.controller.dispose();dom.window.close();});return f;
}
const button=(f,text)=>[...f.root.querySelectorAll('button')].find(value=>value.textContent===text);
function fill(f,title='新しい論文',seriesId=''){
  const form=f.root.querySelector('form');form.elements.title.value=title;form.elements.title.dispatchEvent(new f.dom.window.Event('input'));form.elements.seriesId.value=seriesId;form.elements.seriesId.dispatchEvent(new f.dom.window.Event('change'));
}
const upload=f=>f.root.querySelector('form').onsubmit(new f.dom.window.Event('submit',{cancelable:true}));

test('metadata bounds, private access, unknown/storage fields and unsafe IDs fail closed',()=>{
  assert.deepEqual(researchPdfList(list(),projectId),list());assert.equal(researchPdfList(list([{...pdf,size:MAX_RESEARCH_PDF_BYTES,version:Number.MAX_SAFE_INTEGER}]),projectId).pdfs[0].size,MAX_RESEARCH_PDF_BYTES);
  for(const change of [{id:id+'\n'},{seriesId:'bad'},{title:'x'.repeat(241)},{title:'\ud800'},{title:'x\u0085'},{version:0},{version:1.5},{version:Number.MAX_SAFE_INTEGER+1},{visibility:'restricted'},{scanStatus:'unknown'},{size:0},{size:MAX_RESEARCH_PDF_BYTES+1},{sha256:'A'.repeat(64)},{sha256:'a'.repeat(64)+'\n'},{createdAt:'bad'},{objectKey:'private'},{url:'https://storage.invalid/private'}])assert.throws(()=>researchPdfList(list([{...pdf,...change}]),projectId));
  for(const value of [list([pdf,pdf]),list(Array.from({length:101},()=>pdf)),{...list(),projectId:'other'},{...list(),signedIn:false},{...list(),objectKey:'secret'},list([pdf],false)])assert.throws(()=>researchPdfList(value,projectId));
});
test('initial read uses the closed native detail name and rejects unreadable metadata without displaying it',async t=>{
  const f=fixture(t,{prepared:undefined});await f.controller.ready;assert.deepEqual(f.calls[0],['hub_detail',{name:'research_pdfs',ids:[projectId]}]);assert.match(f.root.textContent,/検査待ち/);
  f.data={...f.data,pdfs:[{...pdf,objectKey:'hidden-secret'}]};assert.equal(await f.controller.refresh(),false);assert.match(f.root.textContent,/PDF一覧を確認できません/);assert.doesNotMatch(f.root.textContent,/hidden-secret/);assert.equal(f.root.querySelector('form'),null);
});
test('state renders inert titles and blocks unscanned or rejected downloads/publication',t=>{
  const f=fixture(t,{data:list([{...pdf,title:'<script>run()</script>'},{...pdf,id:other,seriesId:other,scanStatus:'rejected'}])});assert.equal(f.root.querySelector('script'),null);assert.match(f.root.textContent,/<script>run\(\)<\/script>/);assert.match(f.root.textContent,/検査で拒否/);assert.equal(button(f,'PDFを保存'),undefined);assert.equal(button(f,'確認してこの版を公開'),undefined);assert.equal(f.root.querySelectorAll('button').length,3);
});
test('public clean PDFs are readable without owner mutation/upload controls',async t=>{
  const f=fixture(t,{data:list([{...pdf,visibility:'public',scanStatus:'clean'}],false)});assert.equal(f.root.querySelector('form'),null);assert.equal(button(f,'検査する'),undefined);assert.equal(button(f,'この版を非公開にする'),undefined);await button(f,'PDFを保存').onclick();assert.deepEqual(f.downloads,[{projectId,pdfId:id}]);assert.match(f.root.textContent,/PDFを保存しました/);
});
test('scan and visibility use exact closed commands; publishing requires explicit confirmation',async t=>{
  const f=fixture(t);await button(f,'検査する').onclick();assert.deepEqual(f.calls[0],['hub_client_action',{action:'research_pdf_scan',target:projectId,options:{id}}]);assert.equal(button(f,'検査する'),undefined);const publish=button(f,'確認してこの版を公開');assert.equal(publish.disabled,true);await publish.onclick();assert.equal(f.calls.length,2);
  const check=f.root.querySelector('article input[type="checkbox"]');check.checked=true;check.dispatchEvent(new f.dom.window.Event('change'));await button(f,'確認してこの版を公開').onclick();assert.deepEqual(f.calls[2],['hub_client_action',{action:'research_pdf_visibility',target:projectId,options:{id,visibility:'public'}}]);assert.match(f.root.textContent,/公開範囲を変更/);
});
test('failed scanner stays blocked, stale button cannot repeat a mutation, and optional open uses native callback',async t=>{
  const opened=[],f=fixture(t,{openPdf:async args=>{opened.push(args);return {opened:true};}});f.respond=async(name,args)=>name==='hub_detail'?{...f.data,pdfs:[{...pdf,scanStatus:'failed'}]}:{id,scanStatus:'failed'};const stale=button(f,'検査する');await stale.onclick();await stale.onclick();assert.equal(f.calls.length,2);assert.match(f.root.textContent,/検査に接続できません/);assert.equal(button(f,'PDFを保存'),undefined);
  f.respond=async()=>list([{...pdf,scanStatus:'clean'}]);await f.controller.refresh();await button(f,'PDFを開く').onclick();assert.deepEqual(opened,[{projectId,pdfId:id}]);assert.match(f.root.textContent,/PDFを開きました/);
});
test('native upload carries no path/bytes, preserves revisions, and saves pending privately before any scan',async t=>{
  const f=fixture(t);fill(f,' 改訂論文 ',id);await upload(f);assert.deepEqual(f.uploads,[{projectId,title:'改訂論文',seriesId:id}]);assert.equal(f.calls.filter(([name])=>name==='hub_client_action').length,0);assert.equal(f.root.querySelector('form').elements.title.value,'');assert.match(f.root.textContent,/非公開で保存しました。検査待ち/);
});
test('required PDF title rejects empty, whitespace and unsafe bounds before native selection, and accepts 240 characters',async t=>{
  const f=fixture(t),title=f.root.querySelector('form').elements.title;assert.equal(title.required,true);assert.equal(title.placeholder,'PDFの名前');assert.equal(title.maxLength,240);
  for(const value of ['', ' \u3000 ', 'x'.repeat(241), 'x\n', 'x\u0085', '\ud800']){
    fill(f,value,id);f.state.pdfs.draft.title=value;const draft=structuredClone(f.state.pdfs.draft);await upload(f);assert.deepEqual(f.state.pdfs.draft,draft);assert.equal(f.uploads.length,0);assert.equal(f.calls.length,0);assert.match(f.root.textContent,/PDFの名前を確認/);assert.equal(f.root.querySelector('form').elements.seriesId.value,id);
  }
  fill(f,'x'.repeat(240),id);await upload(f);assert.deepEqual(f.uploads,[{projectId,title:'x'.repeat(240),seriesId:id}]);
});
test('native selection cancellation keeps title and series; unavailable callbacks never fall back to Web',async t=>{
  const f=fixture(t);f.uploadResult=async()=>({cancelled:true});fill(f,'残す名前',id);await upload(f);assert.equal(f.root.querySelector('form').elements.title.value,'残す名前');assert.equal(f.root.querySelector('form').elements.seriesId.value,id);assert.match(f.root.textContent,/アップロードを中止/);
  const absent=fixture(t,{uploadPdf:undefined,downloadPdf:undefined,data:list([{...pdf,scanStatus:'clean'}])});assert.equal(absent.root.querySelector('form button').disabled,true);assert.match(absent.root.textContent,/ネイティブのPDFファイル選択を利用できません/);assert.match(absent.root.textContent,/PDFの保存操作を利用できません/);assert.equal(absent.root.querySelector('a'),null);
});
test('definite upload refusal preserves editable draft; ambiguous receipt requires fresh list and explicit review',async t=>{
  const f=fixture(t);fill(f);f.uploadResult=async()=>{throw Error('research_pdf_upload_rejected:413:large');};await upload(f);assert.equal(f.root.querySelector('form').elements.title.value,'新しい論文');assert.equal(f.root.querySelector('form').elements.title.disabled,false);
  f.uploadResult=async()=>({id:other,version:1,scanStatus:'clean'});await upload(f);assert.equal(f.root.querySelector('form').elements.title.disabled,true);await upload(f);assert.equal(f.uploads.length,2);assert.equal(button(f,'保存済み一覧を確認したので入力を再開する').disabled,true);
  await button(f,'保存済みPDF一覧を確認する').onclick();button(f,'保存済み一覧を確認したので入力を再開する').click();assert.equal(f.root.querySelector('form').elements.title.disabled,false);assert.equal(f.root.querySelector('form').elements.title.value,'新しい論文');
});
test('known upload errors before POST preserve the draft and allow selecting another PDF',async t=>{
  for(const code of ['invalid_id','invalid_origin','invalid_title','dialog_failed','file_unavailable','too_large','read_failed','invalid_format']){
    const f=fixture(t);fill(f,'残す名前',id);f.uploadResult=async()=>{throw Error(`research_pdf_${code}`);};await upload(f);
    assert.deepEqual(f.state.pdfs.draft,{title:'残す名前',seriesId:id});assert.equal(f.root.querySelector('form').elements.title.disabled,false);assert.equal(f.root.querySelector('form button').disabled,false);assert.doesNotMatch(f.root.textContent,/保存結果が未確認/);
    f.uploadResult=async()=>({cancelled:true});await upload(f);assert.equal(f.uploads.length,2);assert.deepEqual(f.state.pdfs.draft,{title:'残す名前',seriesId:id});
  }
});
test('upload and response uncertainty after POST stays locked, including unknown error-code suffixes',async t=>{
  for(const code of ['upload_unknown','response_too_large','receive_failed','too_large_extra','invalid_format\n']){
    const f=fixture(t);fill(f,'残す名前',id);f.uploadResult=async()=>{throw Error(`research_pdf_${code}`);};await upload(f);await upload(f);
    assert.equal(f.uploads.length,1);assert.deepEqual(f.state.pdfs.draft,{title:'残す名前',seriesId:id});assert.equal(f.root.querySelector('form').elements.title.disabled,true);assert.match(f.root.textContent,/保存結果が未確認/);assert.equal(button(f,'保存済み一覧を確認したので入力を再開する').disabled,true);
  }
});
test('account changes clear drafts and ignore late upload, including after dispose',async t=>{
  for(const dispose of [false,true]){
    const f=fixture(t);let finish;f.uploadResult=()=>new Promise(resolve=>finish=resolve);fill(f);const pending=upload(f);if(dispose)f.controller.dispose();f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));finish({id:other,version:1,scanStatus:'pending'});await pending;
    assert.equal(f.state.pdfs,undefined);assert.equal(f.calls.length,0);assert.match(f.root.textContent,/接続が変わりました/);assert.doesNotMatch(f.root.textContent,/非公開で保存しました/);
  }
});
test('ignores stale list replies and forbids actions after injected origin/profile gate changes',async t=>{
  let current=true;const f=fixture(t,{isCurrent:()=>current});const replies=[];f.respond=()=>new Promise(resolve=>replies.push(resolve));const older=f.controller.refresh(),newer=f.controller.refresh();replies[1](list([{...pdf,title:'fresh'}]));await newer;replies[0](list([{...pdf,title:'stale'}]));await older;assert.match(f.root.textContent,/fresh/);assert.doesNotMatch(f.root.textContent,/stale/);current=false;await button(f,'検査する').onclick();assert.equal(f.calls.length,2);
});
test('successful upload with failed list refresh retains saved status and clears the old draft',async t=>{
  const f=fixture(t);fill(f);f.respond=async()=>{throw Error('list unavailable');};await upload(f);assert.match(f.root.textContent,/非公開で保存しました/);assert.match(f.root.textContent,/一覧の更新に失敗/);assert.deepEqual(f.state.pdfs.draft,{title:'',seriesId:''});assert.equal(f.uploads.length,1);
});
