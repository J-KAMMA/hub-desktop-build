import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { build } = require('esbuild');

export async function buildReaderExpression() {
  if (require('@mozilla/readability/package.json').version !== '0.6.0') throw new Error('reader_dependency_version_changed');
  const output = await build({ entryPoints: [fileURLToPath(new URL('./reader-extract.src.mjs', import.meta.url))],
    nodePaths: [fileURLToPath(new URL('../../../../node_modules/', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'HubReaderExtraction',
    platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline' });
  // The bundle's namespace and library internals are function-local, never page globals.
  return `(()=>{${output.outputFiles[0].text}\nreturn HubReaderExtraction.extractReaderPage();})()`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expression = await buildReaderExpression();
  const destination = new URL('./reader-extract.js', import.meta.url);
  const previous = await readFile(destination, 'utf8').catch(error => { if(error.code === 'ENOENT') return null; throw error; });
  if(previous !== expression) await writeFile(destination, expression);

  console.log(JSON.stringify({ sha256: createHash('sha256').update(expression).digest('hex'), bytes: Buffer.byteLength(expression), readability: '0.6.0', license: 'Apache-2.0' }));
}
