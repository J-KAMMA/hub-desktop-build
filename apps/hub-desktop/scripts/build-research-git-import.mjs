import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(new URL('../../../package.json',import.meta.url));
const entry=fileURLToPath(new URL('../../hub/lib/research-git-import.ts',import.meta.url));
const output=fileURLToPath(new URL('../ui/research-git-import-contract.mjs',import.meta.url));
const result=require('esbuild').buildSync({entryPoints:[entry],absWorkingDir:path.dirname(entry),bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
const text=result.outputFiles[0].text;
let existing;
try{existing=readFileSync(output,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(existing!==text)writeFileSync(output,text);
