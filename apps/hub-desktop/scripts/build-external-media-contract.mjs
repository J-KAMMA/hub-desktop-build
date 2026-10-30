import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../../package.json',import.meta.url));
const resolveDir=fileURLToPath(new URL('../../hub/lib/',import.meta.url));
const output=fileURLToPath(new URL('../ui/external-media-contract.mjs',import.meta.url));
const contents=`export {normalizeVideoSource,parseExternalVideoInput} from './video-source.ts';
export {VIDEO_PURPOSES,parseVideoContextInput} from './video-context.ts';
export {normalizeMusicSource,parseMusicWorkInput} from './music-source.ts';`;
const result=require('esbuild').buildSync({stdin:{contents,resolveDir,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
const text=result.outputFiles[0].text;
let existing;
try{existing=readFileSync(output,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(existing!==text)writeFileSync(output,text);
