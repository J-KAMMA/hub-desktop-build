import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const directory=fileURLToPath(new URL('../ui/',import.meta.url));
const browser=['hub-network-app-integration.test.mjs','research-document-code-app.test.mjs'];
const files=(await readdir(directory)).filter(file=>file.endsWith('.test.mjs')).sort();
const heavy='browser-workspace.test.mjs';
if(!files.includes(heavy)||browser.some(file=>!files.includes(file)))throw Error('required_ui_test_missing');
const groups=[files.filter(file=>file!==heavy&&!browser.includes(file)),[heavy],...browser.map(file=>[file])];
for(const group of groups){
 const result=spawnSync(process.execPath,[...(group[0]===heavy?['--max-old-space-size=4096']:[]),'--test',...group.map(file=>join(directory,file))],{stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
