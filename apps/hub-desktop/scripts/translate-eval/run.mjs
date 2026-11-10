// 端末内翻訳モデルの比較。入っているモデルを同じ llama.cpp で動かし、出力・chrF・並べて見る HTML を作る。
// 使い方（重みはこのスクリプトでは取得しない。先に自分で置く）:
//   node run.mjs --models-dir D:\models --llama-server C:\llama\llama-server.exe --llama-cli C:\llama\llama-cli.exe --out .\out
//   --llama-completion <exe>  MADLAD(T5)用。新しい llama.cpp は llama-cli が -no-cnv を受けず、llama-server は T5 で assert するため llama-completion を使う
//   --only plamo-0.8b,madlad-3b   対象を絞る     --limit 10   各言語対の先頭 N 件だけ
// COMET: 環境変数 COMET_CMD にコマンドを入れると、{"src","mt","ref"} の JSON 行を標準入力に流し、
//        1 行 1 数値の標準出力を読む。無ければ chrF のみ。
import {existsSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROMPTS, STOPS, chrf, mean, renderHtml} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const models = JSON.parse(readFileSync(join(here, 'models.json'), 'utf8')).models;
const set = JSON.parse(readFileSync(join(here, 'eval-set.json'), 'utf8')).items;
const outDir = args.out ?? join(here, 'out');
const only = args.only ? new Set(args.only.split(',')) : null;
const limit = args.limit ? Number(args.limit) : Infinity;

const items = (() => { const seen = {}; return set.filter((it) => (seen[it.pair] = (seen[it.pair] ?? 0) + 1) <= limit); })();

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(model, fn) {
  const port = await freePort();
  const child = spawn(args['llama-server'], ['-m', join(args['models-dir'], model.file), '-c', '4096', '--host', '127.0.0.1', '--port', String(port)], {stdio: 'ignore'});
  try {
    for (let i = 0; i < 600; i += 1) {
      const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
      if (ok) return await fn(port);
      await sleep(500);
    }
    throw new Error('server did not become ready');
  } finally { child.kill(); }
}
async function viaServer(port, model, prompt) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/completions`, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({prompt, temperature: 0, max_tokens: 512, stop: STOPS[model.prompt]})});
  return (await r.json()).choices[0].text.trim();
}
function viaCli(model, prompt) {
  const file = join(tmpdir(), `eval-${process.pid}-${Date.now()}.txt`);
  writeFileSync(file, prompt);
  try {
    const r = spawnSync(args['llama-completion'] ?? args['llama-cli'], ['-m', join(args['models-dir'], model.file), '-f', file, '-n', '512', '--temp', '0', '-c', '2048', '-no-cnv', '--no-display-prompt'], {encoding: 'utf8'});
    return (r.stdout ?? '').replace(/[[0-9;]*m/g, '').replace('[end of text]', '').trim();
  } finally { rmSync(file, {force: true}); }
}

const results = {};
for (const model of models) {
  if (only && !only.has(model.id)) continue;
  if (!existsSync(join(args['models-dir'] ?? '', model.file))) { console.log(`skip ${model.id}: file not found`); continue; }
  results[model.id] = {};
  const run = async (port) => {
    for (const it of items) {
      const [from, to] = it.pair.split('-');
      const prompt = PROMPTS[model.prompt](it.src, from, to);
      if (!prompt) continue; // そのモデルが扱わない言語対
      const t0 = performance.now();
      const out = model.runtime === 'llama-cli' ? viaCli(model, prompt) : await viaServer(port, model, prompt);
      results[model.id][it.id] = {out, ms: performance.now() - t0, chrf: chrf(out, it.ref)};
    }
  };
  if (model.runtime === 'llama-cli') await run(null); else await withServer(model, run);
  console.log(`done ${model.id}`);
}

if (process.env.COMET_CMD) {
  for (const [id, byItem] of Object.entries(results)) {
    const rows = items.filter((it) => byItem[it.id]);
    const r = spawnSync(process.env.COMET_CMD, {shell: true, encoding: 'utf8', input: rows.map((it) => JSON.stringify({src: it.src, mt: byItem[it.id].out, ref: it.ref})).join('\n')});
    r.stdout.trim().split('\n').forEach((v, i) => { if (rows[i]) byItem[rows[i].id].comet = Number(v); });
  }
}

const summary = {};
for (const [id, byItem] of Object.entries(results)) {
  summary[id] = {};
  for (const pair of [...new Set(items.map((i) => i.pair))]) {
    const scores = items.filter((i) => i.pair === pair && byItem[i.id]).map((i) => byItem[i.id].chrf);
    if (scores.length) summary[id][pair] = mean(scores);
  }
}
mkdirSync(outDir, {recursive: true});
writeFileSync(join(outDir, 'results.json'), JSON.stringify({results, summary}, null, 2));
writeFileSync(join(outDir, 'report.html'), renderHtml(items, results, summary));
console.log(`wrote ${outDir}`);
