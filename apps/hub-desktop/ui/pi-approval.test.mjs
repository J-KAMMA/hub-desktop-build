import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {renderPiApproval} from './pi-approval.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const run=()=>({id:'run-1',model:'ollama/研究😀',workspace:'C:/共有/研究😀'});
const action=(overrides={})=>({id:'action-1',tool:'hub_exec',summary:'command: node\nargs: --test\nworkspace: C:/共有/研究😀',...overrides});
function fixture(t,options={}) {
  const dom=new JSDOM('<main></main>'),decisions=[],currentRun=run(),currentAction=action();t.after(()=>dom.window.close());
  const root=renderPiApproval({document:dom.window.document,run:currentRun,action:currentAction,onDecide:(...args)=>decisions.push(args),...options});dom.window.document.querySelector('main').append(root);return {dom,root,decisions,run:currentRun,action:currentAction};
}
test('approval displays the exact full Unicode summary and tool/model/workspace with accessible native controls',t=>{
  const summary='長い承認内容😀\n'.repeat(1000)+'最後の引数 --exact',f=fixture(t,{action:action({summary})});
  assert.equal(f.root.className,'piw-approval');assert.equal(f.root.querySelector('strong').textContent,summary);assert.equal(f.root.querySelector('.piw-approval-text').querySelectorAll('.meta').length,2);assert.match(f.root.textContent,/hub_exec/);assert.match(f.root.textContent,/ollama\/研究😀/);assert.match(f.root.textContent,/C:\/共有\/研究😀/);
  const approve=f.root.querySelector('.approve'),deny=f.root.querySelector('.deny');assert.equal(approve.tagName,'BUTTON');assert.equal(approve.type,'button');assert.equal(approve.textContent,'承認');assert.equal(deny.textContent,'拒否');assert.equal(approve.disabled,false);assert.equal(deny.disabled,false);assert.equal(f.root.querySelector('details'),null);approve.click();deny.click();assert.deepEqual(f.decisions,[['run-1','action-1',true],['run-1','action-1',false]]);
});
test('all summary/model/workspace/file values are literal text and produce no injected element or request',t=>{
  const hostile='<img src="https://example.invalid/x" onerror="run()"><script>run()</script>',f=fixture(t,{run:{id:'r',model:hostile,workspace:hostile},action:action({tool:'hub_write',summary:hostile,detail:{path:hostile,before:hostile,after:hostile}})});
  assert.equal(f.root.querySelector('img,script,a,iframe'),null);assert.equal(f.root.querySelector('strong').textContent,hostile);assert.equal(f.root.querySelector('summary').textContent,hostile);assert.deepEqual([...f.root.querySelectorAll('pre')].map(node=>node.textContent),[hostile,hostile]);assert.equal(f.root.querySelector('details').open,true);
});
test('both file tools retain open before and after previews including empty files and stable detail keys',t=>{
  for(const tool of ['hub_write','hub_edit']) {
    const f=fixture(t,{action:action({id:`a-${tool}`,tool,detail:{path:'研究/😀.mjs',before:'',after:'次の内容\n'}})}),preview=f.root.querySelector('details');assert.equal(preview.open,true);assert.equal(preview.dataset.detailKey,`approval:a-${tool}`);assert.equal(preview.querySelector('summary').textContent,'研究/😀.mjs');assert.deepEqual([...preview.querySelectorAll('pre')].map(node=>[node.className,node.getAttribute('aria-label'),node.textContent]),[['dev-output','承認する変更の変更前',''],['dev-output','承認する変更の変更後','次の内容\n']]);assert.equal(f.root.querySelector('.approve').disabled,false);
  }
});
test('missing or non-string file preview blocks approval but always permits denial when idle',t=>{
  for(const tool of ['hub_write','hub_edit'])for(const detail of [undefined,null,{}, {path:'file',before:'old'}, {path:1,before:'',after:''}, {path:'file',before:null,after:''}, {path:'file',before:'',after:0}]) {
    const f=fixture(t,{action:action({tool,detail})}),approve=f.root.querySelector('.approve'),deny=f.root.querySelector('.deny');assert.equal(approve.disabled,true);assert.equal(deny.disabled,false);assert.equal(f.root.querySelector('details'),null);assert.match(f.root.textContent,/変更内容が届いていないため承認できません/);approve.onclick();deny.onclick();assert.deepEqual(f.decisions,[['run-1','action-1',false]]);
  }
});
test('busy blocks native and direct captured clicks for approval and denial including missing preview',t=>{
  for(const current of [action(),action({tool:'hub_write',detail:{path:'file',before:'',after:'new'}}),action({tool:'hub_edit'})]) {
    const f=fixture(t,{action:current,busy:true});for(const button of f.root.querySelectorAll('button')){assert.equal(button.disabled,true);button.click();button.onclick();}assert.deepEqual(f.decisions,[]);
  }
});
test('decisions use captured run/action IDs and callback despite later mutation of input objects',t=>{
  const f=fixture(t);f.run.id='other-run';f.action.id='other-action';f.root.querySelector('.approve').click();f.root.querySelector('.deny').click();assert.deepEqual(f.decisions,[['run-1','action-1',true],['run-1','action-1',false]]);
});
test('non-file command and HTTP descriptions stay complete with no invented preview or parser',t=>{
  for(const [tool,summary] of [['hub_exec','program: git\nargs: ["diff", "--", "研究😀"]\ncwd: C:/共有\ntimeoutMs: 45000'],['hub_http','method: POST\nurl: https://example.invalid/resource\nheaders: {"accept":"application/json"}\nbody: {"title":"研究😀"}']]) {
    const f=fixture(t,{action:action({tool,summary,detail:null})});assert.equal(f.root.querySelector('strong').textContent,summary);assert.equal(f.root.querySelector('details'),null);assert.equal(f.root.querySelector('.approve').disabled,false);
  }
  const empty=fixture(t,{action:action({summary:undefined})});assert.equal(empty.root.querySelector('strong').textContent,'操作の承認待ち');
});
test('seat paging shows 承認待ち n/total with prev/next only, a labelled strip, deny before approve and no bulk or always-allow control',t=>{
  const moves=[],f=fixture(t,{position:{index:1,total:3,onNav:step=>moves.push(step)}});
  assert.match(f.root.querySelector('.piw-approval-strip').textContent,/承認が必要です · hub_exec/);assert.match(f.root.querySelector('.piw-approval-count').textContent,/承認待ち 2\/3/);
  const nav=[...f.root.querySelectorAll('.piw-approval-nav button')];assert.deepEqual(nav.map(button=>button.textContent),['前へ','次へ']);nav[0].click();nav[1].click();assert.deepEqual(moves,[-1,1]);
  assert.deepEqual([...f.root.querySelectorAll('.actions button')].map(button=>button.className),['deny','approve']);assert.equal(/すべて|常に|always/i.test(f.root.textContent),false);
  const edge=fixture(t,{position:{index:0,total:2,onNav:step=>moves.push(step)}});assert.equal(edge.root.querySelector('.piw-approval-nav button').disabled,true);
  assert.equal(fixture(t).root.querySelector('.piw-approval-nav'),null);
});
test('hub_exec and hub_http requests stay complete as literal text in the command-styled headline and purchase keeps its handoff wording',t=>{
  const hostile='<b>x</b>',summary=`method: POST\nurl: https://example.invalid/${hostile}\nheaders: {"a":"b"}\nbody: ${'長'.repeat(5000)}`;
  const f=fixture(t,{action:action({tool:'hub_http',summary,detail:null})});assert.equal(f.root.dataset.kind,'command');assert.equal(f.root.querySelector('strong').textContent,summary);assert.equal(f.root.querySelector('b'),null);
});
