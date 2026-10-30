import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../../package.json',import.meta.url));
const resolveDir=fileURLToPath(new URL('../../hub/lib/',import.meta.url));
const output=fileURLToPath(new URL('../ui/research-public-package.mjs',import.meta.url));
const contents="export {parseResearchForkPackage,researchForkPackagePath,RESEARCH_FORK_BYTES,researchForkDigest} from './research-fork-package.ts';";
const text=require('esbuild').buildSync({stdin:{contents,resolveDir,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false}).outputFiles[0].text;
let existing;try{existing=readFileSync(output,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(existing!==text)writeFileSync(output,text);