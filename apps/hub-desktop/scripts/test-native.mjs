import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const checkpoint=await readFile(join(root,'apps/hub-desktop/src-tauri/src/checkpoint.rs'),'utf8');
if(!checkpoint.includes('fn test_credential_entry(')||!checkpoint.includes('let entry = test_credential_entry(account)?;'))throw Error('isolated_checkpoint_fixture_required');
const fixture=await mkdtemp(join(tmpdir(),'hub-native-tests-'));
const sidecar=join(fixture,'empty-model-list.mjs');
await writeFile(sidecar,"if(process.argv[2]!=='--list-models')process.exit(64);console.log(JSON.stringify({type:'models',models:[],ready:[],locations:{}}));\n");
// Unit fixtures use the cfg(test) credential mock/temp path, never the OS store.
// Model metadata uses this owned empty fixture; ignored integration tests stay ignored.
let status;
try{
 const result=spawnSync('cargo',['test','--release','--lib','--locked',...(process.argv.includes('--offline')?['--offline']:[]),'--manifest-path',join(root,'apps/hub-desktop/src-tauri/Cargo.toml'),'--','--test-threads=1'],{
  cwd:join(root,'apps/hub-desktop/src-tauri'),stdio:'inherit',windowsHide:true,
  env:{...process.env,CARGO_INCREMENTAL:'0',PI_CODING_AGENT_DIR:fixture,PI_WORK_SIDECAR:sidecar},
 });
 if(result.error)throw result.error;status=result.status??1;
}finally{
 const target=await realpath(fixture),inside=relative(await realpath(tmpdir()),target);
 if(!inside||inside.startsWith('..')||isAbsolute(inside)||!basename(target).startsWith('hub-native-tests-'))throw Error('unsafe_fixture_cleanup');
 await rm(target,{recursive:true,force:true});
}
process.exitCode=status;
