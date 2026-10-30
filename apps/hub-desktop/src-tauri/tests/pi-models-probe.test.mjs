import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,writeFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=new URL('../',import.meta.url);
const source=readFileSync(new URL('src/pi_work.rs',root),'utf8');
const quiet=readFileSync(new URL('src/local_cli.rs',root),'utf8');
function actual(text,signature){const start=text.indexOf(signature),end=text.indexOf('\n}',start);assert.ok(start>=0&&end>start,signature);return text.slice(start,end+2);}
const probe=actual(source,'async fn probe_models_registry()');
const command=actual(quiet,'pub(crate) fn quiet_command(');
const model=actual(source,'struct ModelProbe {');
const dependencyNames=['tokio','serde_json'];
const installed=['target/release/deps/','target/debug/deps/'].map(path=>{
 const directory=new URL(path,root);
 return {directory,files:existsSync(directory)?readdirSync(directory):[]};
}).find(({files})=>dependencyNames.every(name=>files.some(file=>file.startsWith('lib'+name+'-')&&file.endsWith('.rlib'))));
assert.ok(installed,'Existing release or debug Tokio and serde_json artifacts required');
const deps=installed.directory;
const crate=name=>{const matches=installed.files.filter(file=>file.startsWith('lib'+name+'-')&&file.endsWith('.rlib'));assert.ok(matches.length,'Existing '+name+' runtime artifact required');matches.sort((a,b)=>statSync(new URL(b,deps)).mtimeMs-statSync(new URL(a,deps)).mtimeMs);return new URL(matches[0],deps);};
function tool(program,args,options={}){const result=spawnSync(program,args,{windowsHide:true,encoding:'utf8',maxBuffer:1024*1024,...options});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);return result.stdout;}
test('actual model probe preserves completed metadata and closes a timed-out synthetic child',async t=>{
 t.diagnostic('Runtime artifacts: '+fileURLToPath(deps));
 const directory=mkdtempSync(join(tmpdir(),'hub-models-probe-'));
 try {
  const harness=join(directory,'probe.rs'),exe=join(directory,process.platform==='win32'?'probe.exe':'probe');
  writeFileSync(harness,[
   'use std::{collections::HashMap,path::PathBuf,time::Duration};',
   'mod local_cli { use tokio::process::Command; '+command+' }',model,probe,
   'fn resolve_script(_:Option<PathBuf>)->Result<PathBuf,()> { Ok(std::env::args_os().nth(1).unwrap().into()) }',
   'fn main() { let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();',
   'let result=runtime.block_on(probe_models_registry());',
   'println!("{}",result.map(|value|serde_json::json!({"models":value.models,"ready":value.ready,"locations":value.locations})).unwrap_or(serde_json::Value::Null)); }',
  ].join('\n'));
  tool('rustc',['--edition=2021',harness,'-o',exe,'-L','dependency='+fileURLToPath(deps),
   '--extern','tokio='+fileURLToPath(crate('tokio')),
   '--extern','serde_json='+fileURLToPath(crate('serde_json'))],{timeout:60000});
  const frame={type:'models',models:['synthetic/metadata'],ready:[],locations:{'synthetic/metadata':'local','synthetic/untrusted':'unknown'}};
  const script=join(directory,'synthetic-list-models.cjs');
  writeFileSync(script,'if(process.argv[2]!=="--list-models")throw Error("Wrong mode");console.log('+JSON.stringify(JSON.stringify(frame))+');');
  assert.deepEqual(JSON.parse(tool(exe,[script],{timeout:20000})),{models:frame.models,ready:[],locations:{'synthetic/metadata':'local'}});
  const pidFile=join(directory,'synthetic.pid');
  writeFileSync(script,'if(process.argv[2]!=="--list-models")throw Error("Wrong mode");require("node:fs").writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));console.log('+JSON.stringify(JSON.stringify(frame))+');setInterval(()=>{},1000);');
  const started=Date.now();
  assert.equal(JSON.parse(tool(exe,[script],{timeout:20000})),null,'A frame without successful process exit is not a completed probe');
  assert.ok(Date.now()-started>=14000,'Keep the production 15 second timeout');
  const child=Number(readFileSync(pidFile,'utf8'));assert.ok(Number.isSafeInteger(child)&&child>0);
  const alive=()=>{try{process.kill(child,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  for(let attempt=0;attempt<40&&alive();attempt++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(alive(),false,'Timeout must reap this test-owned synthetic Node, not leave another metadata probe alive');
 } finally {assert.ok(directory.startsWith(join(tmpdir(),'hub-models-probe-')));rmSync(directory,{recursive:true,force:true});}
});
